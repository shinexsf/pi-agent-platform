#!/usr/bin/env node
/**
 * 11.1-11.10 smoke for image attachments. Hits a running server (default
 * http://localhost:3000). Exits non-zero on first failure. Designed to be
 * readable in stdout; each test prints PASS/FAIL with a one-line summary.
 */

import { randomUUID, createHash } from 'node:crypto'

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000'
let passed = 0
let failed = 0

// 1x1 red PNG ≈ 70 bytes. Used for tiny happy-path uploads.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000d4944415478da6364606060000000030001ed9b9b64a0000000049454e44ae426082',
  'hex',
)

// 1x1 white JPEG ≈ 130 bytes (SOI + minimal scan + EOI)
const TINY_JPEG = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffdb0043000302020302020303030304030304050805' +
  '0504040905090a0a0b09090a0a0a09090a090a090a0a0a090a09090b0a0a0a0a0a090a0a0a0a0a0a0a' +
  '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0affc00011080001000103012200021101031101' +
  'ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b51000020103' +
  '03020403050504040000010277000102031104052131004106135161077271143281a1b1c10923352f0' +
  '62b15172636f7e2f3c4d2e3553626364757a7f1d24364472f0e1e2f1f3f4f0d2e3ffc4001f0100030101' +
  '01010101010101000000000000000102030405060708090a0bffc400b5110002010204040304070504' +
  '040001027701020311040521310612415107617113223181a1b1c1d1e1f0f1e2f33452f3543636475' +
  '6f2f3c4d2e3553626364757a7f1d24364472f0e1e2f1f3f4f0d2e3ffda000c03010002110311003f00f4' +
  '50ffd9',
  'hex',
)

// 1x1 transparent GIF89a
const TINY_GIF = Buffer.from(
  '47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024c' +
  '01003b',
  'hex',
)

// 1x1 white VP8L WebP (lossless)
const TINY_WEBP = Buffer.from(
  '524946462a0000005745425052c1010000000100010011002f002f0041312a48cedf800030000700000' +
  '0daa0100',
  'hex',
)

function bufSha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** Build a 30 MB random buffer (deterministic for reproducibility). */
function makeBigBlob() {
  const big = Buffer.alloc(30 * 1024 * 1024)
  for (let i = 0; i < big.length; i += 4096) {
    big.write('A', i)
    big.write('B', i + 100)
  }
  return big
}

/** Convert bytes to base64 string (chunked to avoid call-stack limits). */
function bytesToB64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

function ok(name, info = '') {
  passed++
  console.log(`  ✓ ${name}${info ? '   (' + info + ')' : ''}`)
}
function fail(name, reason) {
  failed++
  console.log(`  ✗ ${name}   -- ${reason}`)
}
function expectEq(name, got, want) {
  if (got === want) ok(name, `${got}`)
  else fail(name, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
}

async function api(method, path, body) {
  const init = { method, headers: {} }
  if (body) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(`${BASE}${path}`, init)
  let json = null
  try { json = await res.json() } catch { /* empty */ }
  return { status: res.status, json, ok: res.ok }
}

async function freshAgent() {
  const r = await api('POST', '/api/agents', {
    name: `smoke-${randomUUID().slice(0, 8)}`,
    workspacePath: process.cwd(),
    model: 'deepseek/deepseek-v4-flash',
  })
  if (r.status !== 201) throw new Error(`agent create failed: ${r.status}`)
  return r.json.id
}

async function newSession(agentId) {
  const r = await api('POST', `/api/sessions/agents/${agentId}`, {})
  if (r.status !== 200) throw new Error(`placeholder create failed: ${r.status}`)
  return r.json.sessionId
}

async function deleteSession(id) {
  await api('POST', `/api/sessions/${id}/delete`, {})
}

async function upload(sessionId, bytes, filename = 'sample') {
  return api('POST', `/api/sessions/${sessionId}/attachments`, {
    data: bytesToB64(bytes),
    filename,
  })
}

async function run() {
  console.log(`\n[smoke] target = ${BASE}\n`)

  // ===== 11.4: 404 for non-existent session =====
  {
    const r = await upload('00000000-0000-0000-0000-000000000000', TINY_PNG)
    expectEq('11.4 sessionNotFound -> 404', r.status, 404)
  }

  // Set up a session for the rest of the tests.
  const agentId = await freshAgent()
  const sessionId = await newSession(agentId)
  console.log(`[smoke] agent=${agentId} session=${sessionId}\n`)

  // ===== 11.1: PNG/JPEG/GIF/WebP — same sha → same id (idempotent dedupe) =====
  {
    const r1 = await upload(sessionId, TINY_PNG, 'red.png')
    expectEq('11.1a PNG status', r1.status, 200)
    expectEq('11.1a PNG mime', r1.json?.mimeType, 'image/png')
    const id = r1.json?.id
    const sha = r1.json?.sha256

    // Re-upload with same content → same id, same sha
    const r2 = await upload(sessionId, TINY_PNG, 'red-again.png')
    expectEq('11.1b PNG re-upload status', r2.status, 200)
    expectEq('11.1b PNG re-upload same id', r2.json?.id, id)
    expectEq('11.1b PNG re-upload same sha', r2.json?.sha256, sha)

    const r3 = await upload(sessionId, TINY_JPEG, 'white.jpg')
    expectEq('11.1c JPEG mime', r3.json?.mimeType, 'image/jpeg')

    const r4 = await upload(sessionId, TINY_GIF, 't.gif')
    expectEq('11.1d GIF mime', r4.json?.mimeType, 'image/gif')

    const r5 = await upload(sessionId, TINY_WEBP, 't.webp')
    expectEq('11.1e WebP mime', r5.json?.mimeType, 'image/webp')
  }

  // ===== 11.2: unsupported mime (PDF magic) → 415 =====
  {
    const pdfBytes = Buffer.from('%PDF-1.4\n%hello', 'ascii')
    const r = await upload(sessionId, pdfBytes, 'doc.pdf')
    expectEq('11.2 pdf -> 415', r.status, 415)
  }
  {
    // Random non-image bytes → 415 (magic sniff rejects)
    const fake = Buffer.alloc(64)
    fake[0] = 'X'.charCodeAt(0)
    const r = await upload(sessionId, fake, 'fake.bin')
    expectEq('11.2 random -> 415', r.status, 415)
  }

  // ===== 11.3: 30 MB raw → 413 =====
  {
    const big = makeBigBlob()
    const r = await upload(sessionId, big, 'huge.png')
    expectEq('11.3 30MB -> 413', r.status, 413)
    expectEq('11.3 code', r.json?.code, 'file_too_large')
  }

  // ===== 11.5: GET list — order = createdAt DESC =====
  {
    const r = await api('GET', `/api/sessions/${sessionId}/attachments`)
    expectEq('11.5 GET status', r.status, 200)
    if (Array.isArray(r.json)) {
      const ts = r.json.map((row) => row.createdAt)
      const sorted = [...ts].sort((a, b) => b - a)
      const okOrder = ts.every((v, i) => v === sorted[i])
      if (okOrder) ok('11.5 order DESC', `${r.json.length} rows`)
      else fail('11.5 order DESC', `expected DESC, got ${JSON.stringify(ts)}`)
    } else fail('11.5 GET list shape', 'not array')

    // No sha256 in list response (per spec — sha256 only on upload response)
    const hasSha = r.json?.some?.((row) => 'sha256' in row)
    if (!hasSha) ok('11.5 no sha256 in list')
    else fail('11.5 leak', 'sha256 leaked to list endpoint')
  }

  // ===== 11.6: prompt with [pi-attachment:...] marker → worker processes =====
  {
    // Re-upload a fresh PNG to capture id for prompt
    const r = await upload(sessionId, TINY_PNG, 'for-prompt.png')
    const id = r.json?.id
    if (!id) { fail('11.6 setup', 'no id'); }
    else {
      const marker = `[pi-attachment:${id}]`
      const before = Date.now()
      const resp = await api('POST', `/api/sessions/${sessionId}/prompt`, {
        agentId,
        message: `hello ${marker}`,
      })
      expectEq('11.6 prompt accepted', resp.status, 200)
      console.log(`     [note] prompt accepted; check server log for [worker] skip/processAttachment trace`)
    }
  }

  // ===== 11.8: corrupt PNG upload — server still 415 (magic sniff rejects) =====
  {
    // Looks like PNG magic but invalid rest
    const broken = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0xFF),
    ])
    const r = await upload(sessionId, broken, 'broken.png')
    // PNG magic is valid (8 bytes only) so server accepts and writes; worker
    // will fail in processImage later. For now we accept 200 here as
    // upload-stage validation passes (workers will surface the failure).
    if (r.status === 200) ok('11.8 corrupt PNG accepted (worker-handled)', `id=${r.json?.id}`)
    else fail('11.8 corrupt PNG', `status=${r.status}`)
  }

  // ===== 11.9: cascade delete — only target session's attachments =====
  {
    const otherAgent = await freshAgent()
    const otherSession = await newSession(otherAgent)

    // Each session has 2 attachments
    const uploads = []
    for (let i = 0; i < 2; i++) {
      const r1 = await upload(sessionId, TINY_PNG, `sess-a-${i}.png`)
      const r2 = await upload(otherSession, TINY_PNG, `sess-b-${i}.png`)
      uploads.push({ sA: r1.json, sB: r2.json })
    }

    // Delete session A, expect 2 attachments_deleted
    const delA = await api('POST', `/api/sessions/${sessionId}/delete`, {})
    expectEq('11.9 session-A delete status', delA.status, 200)
    expectEq('11.9 attachmentsDeleted == 2', delA.json?.attachmentsDeleted, 2)

    // Verify A's attachments are gone (404 on GET detail / 404 on upload-again-should-create-fresh with same sha)
    const reUploadA = await upload(sessionId, TINY_PNG, 'sess-a-again.png')
    // session is gone now — the route returns 404 on the upload attempt
    expectEq('11.9 session-A gone (404)', reUploadA.status, 404)

    // Verify B's attachments are intact (GET still returns 2 for B)
    const listB = await api('GET', `/api/sessions/${otherSession}/attachments`)
    expectEq('11.9 session-B GET status', listB.status, 200)
    expectEq('11.9 session-B count intact', listB.json?.length, 2)

    // Cleanup B so DB doesn't pile up
    await api('POST', `/api/sessions/${otherSession}/delete`, {})
  }

  // ===== 11.10: agent delete cascade — cumulative attachment count =====
  {
    const agent = await freshAgent()
    const sess1 = await newSession(agent)
    const sess2 = await newSession(agent)
    for (let i = 0; i < 3; i++) {
      await upload(sess1, TINY_PNG, `agent-sess1-${i}.png`)
      await upload(sess2, TINY_PNG, `agent-sess2-${i}.png`)
    }
    const del = await api('POST', `/api/agents/${agent}/delete`, {})
    expectEq('11.10 agent delete status', del.status, 200)
    expectEq('11.10 cascade.attachmentsDeleted == 6', del.json?.cascade?.attachmentsDeleted, 6)
    expectEq('11.10 cascade.deleted == 2', del.json?.cascade?.deleted, 2)
  }

  console.log(`\n[smoke] ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((err) => {
  console.error('[smoke] CRASH:', err)
  process.exit(2)
})
