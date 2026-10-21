// Server-side STEP export: OnShape → Vercel Blob → card, with no browser involved.
//
// The panel used to export the STEP file itself, so the student had to keep the
// panel open and wait for OnShape (the old 20s limit dropped slow exports silently),
// and the file had to squeeze through Vercel's 4.5 MB request limit twice.
// Now createCard starts this in the background (waitUntil) and responds right away;
// the export finishes even if the student closes the tab.
//
// step_export_status on the card: 'pending' → 'done', or 'failed: <reason>'.

import { put, del } from '@vercel/blob';

// Must finish inside api/board.js maxDuration (vercel.json) with room for the
// download, upload, and DB write after the translation completes.
const TRANSLATION_DEADLINE_MS = 45000;
// Poll gaps grow over time: fast exports finish quickly, slow ones don't burn API calls
const POLL_SCHEDULE_MS = [1500, 2000, 2000, 3000, 3000, 4000, 5000]; // then 5s each

// OnShape IDs are short alphanumeric strings. Validate before building API paths.
const ID_RE = /^[A-Za-z0-9]{1,64}$/;

export function parseStepExportRequest(x) {
  if (!x || typeof x !== 'object') return null;
  const { docId, wvmType, wvmId, elementId, partId } = x;
  if (wvmType !== 'w' && wvmType !== 'v') return null;
  if (![docId, wvmId, elementId, partId].every(v => typeof v === 'string' && ID_RE.test(v))) return null;
  return { docId, wvmType, wvmId, elementId, partId };
}

export function stepFilename(partName) {
  const base = String(partName || 'part').trim().replace(/[^\w.-]+/g, '_').slice(0, 80) || 'part';
  return `${base}.step`;
}

function onshapeFetch(path, init = {}) {
  const auth = Buffer.from(`${process.env.ONSHAPE_ACCESS_KEY}:${process.env.ONSHAPE_SECRET_KEY}`).toString('base64');
  return fetch(`https://cad.onshape.com/api/v6${path}`, {
    ...init,
    headers: { Authorization: 'Basic ' + auth, Accept: 'application/json', 'Content-Type': 'application/json' },
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Runs the whole export and records the outcome on the card. Never throws.
export async function runStepExport(sql, cardId, req, filename) {
  const start = Date.now();
  try {
    const { docId, wvmType, wvmId, elementId, partId } = req;

    // 1. Ask OnShape to translate the part to STEP
    const tResp = await onshapeFetch(
      `/partstudios/d/${docId}/${wvmType}/${wvmId}/e/${elementId}/translations`,
      { method: 'POST', body: JSON.stringify({ formatName: 'STEP', partIds: partId, storeInDocument: false, translate: true }) }
    );
    if (!tResp.ok) throw new Error(`OnShape rejected the export request (${tResp.status})`);
    const { id: translationId } = await tResp.json();

    // 2. Wait for OnShape to finish
    let foreignId = null;
    for (let i = 0; Date.now() - start < TRANSLATION_DEADLINE_MS; i++) {
      await sleep(POLL_SCHEDULE_MS[i] ?? 5000);
      const pResp = await onshapeFetch(`/translations/${translationId}`);
      if (!pResp.ok) throw new Error(`OnShape status check failed (${pResp.status})`);
      const poll = await pResp.json();
      if (poll.requestState === 'DONE') { foreignId = poll.resultExternalDataIds?.[0]; break; }
      if (poll.requestState === 'FAILED') throw new Error(poll.failureReason || 'OnShape could not translate the part');
    }
    if (!foreignId) throw new Error(`OnShape took longer than ${TRANSLATION_DEADLINE_MS / 1000}s`);
    const translatedAt = Date.now();

    // 3. Download from OnShape and store in Blob, server to server
    const fResp = await onshapeFetch(`/documents/d/${docId}/externaldata/${foreignId}`);
    if (!fResp.ok) throw new Error(`Downloading the STEP file failed (${fResp.status})`);
    const bytes = Buffer.from(await fResp.arrayBuffer());
    const blob = await put(`step-files/${cardId}/${filename}`, bytes, {
      access: 'public',
      contentType: 'application/octet-stream',
      addRandomSuffix: false,
    });

    // 4. Attach to the card, unless someone attached or removed a file by hand
    // while this was running (updateCard clears the status), or deleted the card
    const updated = await sql`
      UPDATE cards SET step_file_url = ${blob.url}, step_file_name = ${filename},
        step_export_status = 'done', updated_at = NOW()
      WHERE id = ${cardId} AND step_export_status = 'pending'
      RETURNING id
    `;
    if (!updated.length) {
      try { await del(blob.url); } catch (_) {}
      console.log(`[step-export] card ${cardId}: no longer pending, discarded export`);
      return;
    }
    console.log(`[step-export] card ${cardId}: done in ${((Date.now() - start) / 1000).toFixed(1)}s ` +
      `(OnShape ${((translatedAt - start) / 1000).toFixed(1)}s), ${(bytes.length / 1024).toFixed(0)} KB`);
  } catch (err) {
    const reason = String(err?.message || err).slice(0, 200);
    console.error(`[step-export] card ${cardId}: failed after ${((Date.now() - start) / 1000).toFixed(1)}s: ${reason}`);
    try {
      await sql`
        UPDATE cards SET step_export_status = ${'failed: ' + reason}, updated_at = NOW()
        WHERE id = ${cardId} AND step_export_status = 'pending'
      `;
    } catch (dbErr) {
      console.error(`[step-export] card ${cardId}: could not record failure:`, dbErr);
    }
  }
}
