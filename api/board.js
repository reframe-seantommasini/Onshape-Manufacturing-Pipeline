// Vercel serverless function — proxies all kanban board API calls.
// Database: Neon (serverless Postgres) via @neondatabase/serverless
// File storage: Vercel Blob via @vercel/blob
//
// Required Vercel env vars (auto-populated when you connect via Vercel dashboard):
//   DATABASE_URL          — Neon connection string (added automatically by Neon integration)
//   BLOB_READ_WRITE_TOKEN — Vercel Blob token (added automatically by Blob integration)

import { neon } from '@neondatabase/serverless';
import { put, del } from '@vercel/blob';
import { waitUntil } from '@vercel/functions';
import { parseStepExportRequest, runStepExport, stepFilename } from '../lib/step-export.js';

// ── Schema upgrade ───────────────────────────────────────────────────────────
// step_export_status was added for background STEP export. Add it if missing,
// checked once per function instance so existing deployments upgrade themselves.
let _schemaReady = false;
async function ensureSchema(sql) {
  if (_schemaReady) return;
  const cols = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cards' AND column_name = 'step_export_status'
  `;
  if (!cols.length) await sql`ALTER TABLE cards ADD COLUMN IF NOT EXISTS step_export_status text`;
  _schemaReady = true;
}

// ── Google ID-token verification ─────────────────────────────────────────────
// Destructive / mutating operations (update, move, delete) require a valid
// Google ID token in the  Authorization: Bearer <token>  request header.
// createCard and file-upload actions are intentionally left open so the OnShape
// panel (which has no Google auth) can still submit cards.
//
// Required Vercel env var: GOOGLE_ALLOWED_DOMAIN  (e.g. "littletonrobotics.org")
// Optional env var:        GOOGLE_CLIENT_ID       (tightens audience verification)
//
// The board frontend stores the credential in sessionStorage on sign-in and
// sends it on every POST.  GIS auto-prompt (data-auto_prompt="true") refreshes
// it silently on page load so it stays current.
const _tokenCache = new Map(); // token → true|false, cleared after TTL

async function requireAuth(req, res) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required — please sign out and sign in again' });
    return false;
  }
  const token = auth.slice(7);

  // Check in-process cache first (avoids a Google round-trip per request)
  if (_tokenCache.has(token)) {
    if (_tokenCache.get(token)) return true;
    res.status(401).json({ error: 'Invalid or expired session — please sign out and sign in again' });
    return false;
  }

  try {
    const r = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`
    );
    if (!r.ok) throw new Error('tokeninfo returned ' + r.status);
    const info = await r.json();

    // Optional: check the token was issued for this app's client ID
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (clientId && info.aud !== clientId) throw new Error('audience mismatch');

    // Required: check the email belongs to the allowed domain
    const domain = process.env.GOOGLE_ALLOWED_DOMAIN;
    if (domain && !info.email?.endsWith('@' + domain)) throw new Error('domain not allowed');

    // Cache positive result for 5 minutes
    _tokenCache.set(token, true);
    setTimeout(() => _tokenCache.delete(token), 5 * 60 * 1000);
    return true;
  } catch {
    // Cache negative result for 1 minute to limit repeated Google calls
    _tokenCache.set(token, false);
    setTimeout(() => _tokenCache.delete(token), 60 * 1000);
    res.status(401).json({ error: 'Invalid or expired session — please sign out and sign in again' });
    return false;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'DATABASE_URL not configured — connect Neon in Vercel dashboard' });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN not configured — connect Blob in Vercel dashboard' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    await ensureSchema(sql);

    // GET → getCards (requires auth — card data should not be world-readable)
    if (req.method === 'GET') {
      if (!await requireAuth(req, res)) return;
      const cards = await sql`SELECT * FROM cards ORDER BY created_at DESC`;
      return res.json({ ok: true, cards });
    }

    // POST → action-based
    const { action, card, id, status: newStatus, updates } = req.body || {};

    if (action === 'createCard') {
      const c = card;
      // Optional background STEP export (see lib/step-export.js)
      const stepExport = parseStepExportRequest(c.stepExport);
      const rows = await sql`
        INSERT INTO cards (
          name, status, project, machine, material, thickness,
          part_type, quantity, finish, assigned_to, cad_link, notes,
          step_file_url, step_file_name, pdf_file_url, pdf_file_name,
          part_id, submitted_by, is_critical, thumbnail_url, step_export_status
        ) VALUES (
          ${c.name        || ''},
          ${c.status      || 'Needs Drawing'},
          ${c.project     || null},
          ${c.machine     || null},
          ${c.material    || null},
          ${c.thickness   || null},
          ${c.partType    || null},
          ${c.qty         ? parseInt(c.qty, 10) : null},
          ${c.finish      || null},
          ${c.student     || c.assigned_to || null},
          ${c.cadLink     || c.cad_link    || null},
          ${c.notes       || null},
          ${c.stepFileUrl  || null},
          ${c.stepFileName || null},
          ${c.pdfFileUrl   || null},
          ${c.pdfFileName  || null},
          ${c.partId      || null},
          ${c.submittedBy || c.student || null},
          ${c.isCritical  ? true : false},
          ${c.thumbnailUrl || null},
          ${stepExport ? 'pending' : null}
        )
        RETURNING *
      `;
      if (stepExport) {
        // Respond now; the export keeps running after the response is sent
        waitUntil(runStepExport(sql, rows[0].id, stepExport, stepFilename(c.name)));
      }
      return res.json({ ok: true, card: rows[0] });

    } else if (action === 'updateCard') {
      if (!await requireAuth(req, res)) return;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const u = updates || {};
      // Coerce quantity: empty string → null, otherwise parse as integer
      const qty = u.quantity === undefined ? undefined
                : (u.quantity === '' || u.quantity === null) ? null
                : parseInt(u.quantity, 10);
      // Replacing or removing the STEP file: remember the old URL so its blob can be deleted
      let oldStepUrl = null;
      if (u.stepFileUrl !== undefined) {
        const rows = await sql`SELECT step_file_url FROM cards WHERE id = ${id}`;
        oldStepUrl = rows[0]?.step_file_url || null;
      }
      await sql`
        UPDATE cards SET
          name           = COALESCE(${u.name          ?? null}, name),
          status         = COALESCE(${u.status        ?? null}, status),
          project        = CASE WHEN ${u.project        !== undefined} THEN ${u.project        ?? null} ELSE project     END,
          machine        = CASE WHEN ${u.machine        !== undefined} THEN ${u.machine        ?? null} ELSE machine     END,
          material       = CASE WHEN ${u.material       !== undefined} THEN ${u.material       ?? null} ELSE material    END,
          thickness      = CASE WHEN ${u.thickness      !== undefined} THEN ${u.thickness      ?? null} ELSE thickness   END,
          part_type      = CASE WHEN ${u.partType       !== undefined} THEN ${u.partType       ?? null} ELSE part_type   END,
          quantity       = CASE WHEN ${qty              !== undefined} THEN ${qty              ?? null} ELSE quantity    END,
          finish         = CASE WHEN ${u.finish         !== undefined} THEN ${u.finish         ?? null} ELSE finish      END,
          assigned_to    = CASE WHEN ${u.assigned       !== undefined} THEN ${u.assigned       ?? null} ELSE assigned_to END,
          cad_link       = CASE WHEN ${u.cadLink        !== undefined} THEN ${u.cadLink        ?? null} ELSE cad_link    END,
          notes          = CASE WHEN ${u.notes          !== undefined} THEN ${u.notes          ?? null} ELSE notes       END,
          step_file_url  = CASE WHEN ${u.stepFileUrl    !== undefined} THEN ${u.stepFileUrl    ?? null} ELSE step_file_url  END,
          step_file_name = CASE WHEN ${u.stepFileName   !== undefined} THEN ${u.stepFileName   ?? null} ELSE step_file_name END,
          pdf_file_url   = CASE WHEN ${u.pdfFileUrl     !== undefined} THEN ${u.pdfFileUrl     ?? null} ELSE pdf_file_url   END,
          pdf_file_name  = CASE WHEN ${u.pdfFileName    !== undefined} THEN ${u.pdfFileName    ?? null} ELSE pdf_file_name  END,
          is_critical    = CASE WHEN ${u.isCritical     !== undefined} THEN ${u.isCritical     ?? false} ELSE is_critical   END,
          thumbnail_url  = CASE WHEN ${u.thumbnailUrl   !== undefined} THEN ${u.thumbnailUrl   ?? null}  ELSE thumbnail_url  END,
          -- A manual attach/remove replaces any background export state
          step_export_status = CASE WHEN ${u.stepFileUrl !== undefined} THEN NULL ELSE step_export_status END,
          updated_at     = NOW()
        WHERE id = ${id}
      `;
      if (oldStepUrl && oldStepUrl !== (u.stepFileUrl ?? null)) {
        try { await del(oldStepUrl); } catch (_) {}
      }
      return res.json({ ok: true });

    } else if (action === 'moveCard') {
      if (!await requireAuth(req, res)) return;
      if (!id || !newStatus) return res.status(400).json({ error: 'Missing id or status' });
      await sql`UPDATE cards SET status = ${newStatus}, updated_at = NOW() WHERE id = ${id}`;
      return res.json({ ok: true });

    } else if (action === 'deleteCard') {
      if (!await requireAuth(req, res)) return;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const rows = await sql`SELECT step_file_url, pdf_file_url, thumbnail_url FROM cards WHERE id = ${id}`;
      if (rows[0]?.step_file_url) {
        try { await del(rows[0].step_file_url); } catch (_) {}
      }
      if (rows[0]?.pdf_file_url) {
        try { await del(rows[0].pdf_file_url); } catch (_) {}
      }
      if (rows[0]?.thumbnail_url) {
        try { await del(rows[0].thumbnail_url); } catch (_) {}
      }
      await sql`DELETE FROM cards WHERE id = ${id}`;
      return res.json({ ok: true });

    } else if (action === 'uploadStep') {
      const { filename, cardId, fileBase64 } = req.body || {};
      if (!filename || !fileBase64) return res.status(400).json({ error: 'Missing filename or fileBase64' });

      const fileBuffer = Buffer.from(fileBase64, 'base64');
      const blobPath = `step-files/${cardId || 'unassigned'}/${filename}`;

      const blob = await put(blobPath, fileBuffer, {
        access: 'public',
        contentType: 'application/octet-stream',
        addRandomSuffix: false,
      });

      return res.json({ ok: true, url: blob.url });

    } else if (action === 'uploadPdf') {
      const { filename, cardId, fileBase64 } = req.body || {};
      if (!filename || !fileBase64) return res.status(400).json({ error: 'Missing filename or fileBase64' });

      const fileBuffer = Buffer.from(fileBase64, 'base64');
      const blobPath = `pdf-files/${cardId || 'unassigned'}/${filename}`;

      const blob = await put(blobPath, fileBuffer, {
        access: 'public',
        contentType: 'application/pdf',
        addRandomSuffix: false,
      });

      return res.json({ ok: true, url: blob.url });

    } else if (action === 'uploadThumbnail') {
      const { filename, cardId, fileBase64 } = req.body || {};
      if (!filename || !fileBase64) return res.status(400).json({ error: 'Missing filename or fileBase64' });

      const fileBuffer = Buffer.from(fileBase64, 'base64');
      const blobPath = `thumbnails/${cardId || 'unassigned'}/${filename}`;

      const blob = await put(blobPath, fileBuffer, {
        access: 'public',
        contentType: 'image/png',
        addRandomSuffix: false,
      });

      return res.json({ ok: true, url: blob.url });

    } else if (action === 'getStepUrl') {
      // Vercel Blob URLs are permanent public URLs — just return what's stored on the card
      const { url } = req.body || {};
      if (!url) return res.status(400).json({ error: 'Missing url' });
      return res.json({ ok: true, url });

    } else {
      return res.status(400).json({ error: 'Unknown action: ' + action });
    }

  } catch (err) {
    console.error('[board.js]', err);
    return res.status(500).json({ error: err.message });
  }
}
