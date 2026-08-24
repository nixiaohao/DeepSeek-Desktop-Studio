// Verify a Windows PE executable embeds an icon (RT_GROUP_ICON / RT_ICON).
const fs = require('fs')
const path = require('path')

function check(file) {
  const b = fs.readFileSync(file)
  if (b.readUInt16LE(0) !== 0x5a4d) return `${file}: not a PE (no MZ)`
  const e_lfanew = b.readUInt32LE(0x3c)
  if (b.toString('ascii', e_lfanew, e_lfanew + 4) !== 'PE\x00\x00')
    return `${file}: no PE signature`
  const optHdr = e_lfanew + 24
  const magic = b.readUInt16LE(optHdr) // 0x10b = PE32, 0x20b = PE32+
  const optHdrSize = b.readUInt16LE(optHdr + 20) // SizeOfOptionalHeader
  const ddOffset = magic === 0x20b ? optHdr + 112 : optHdr + 96
  const resRva = b.readUInt32LE(ddOffset + 2 * 4) // IMAGE_DIRECTORY_ENTRY_RESOURCE
  const resSize = b.readUInt32LE(ddOffset + 2 * 4 + 4)
  if (resRva === 0) return `${file}: NO resource directory (no icon)`
  // Find section containing resRva to convert RVA->file offset
  const numSec = b.readUInt16LE(e_lfanew + 6)
  const secStart = optHdr + optHdrSize
  let resFileOff = -1
  for (let i = 0; i < numSec; i++) {
    const s = secStart + i * 40
    const vsize = b.readUInt32LE(s + 8)
    const vaddr = b.readUInt32LE(s + 12)
    const rawOff = b.readUInt32LE(s + 20)
    if (resRva >= vaddr && resRva < vaddr + vsize) {
      resFileOff = rawOff + (resRva - vaddr)
      break
    }
  }
  // Fallback: for self-extracting archives the resource RVA may equal the
  // raw file offset (no section relocation). Try that before giving up.
  if (resFileOff < 0) resFileOff = resRva
  if (resFileOff < 0 || resFileOff + 16 > b.length) return `${file}: cannot locate resource section`
  // Walk root resource directory for RT_ICON(3) or RT_GROUP_ICON(14)
  const rootEntries = b.readUInt16LE(resFileOff + 12) + b.readUInt16LE(resFileOff + 14)
  let found = []
  for (let i = 0; i < rootEntries; i++) {
    const e = resFileOff + 16 + i * 8
    const id = b.readUInt32LE(e)
    if (id === 3 || id === 14) found.push(id === 3 ? 'RT_ICON' : 'RT_GROUP_ICON')
  }
  return found.length
    ? `${path.basename(file)}: HAS icon (${found.join(', ')})`
    : `${path.basename(file)}: resource dir present but NO icon entry`
}

const files = process.argv.slice(2)
if (!files.length) files.push('dist/DeepSeek Studio-0.1.0-win-x64.exe')
for (const f of files) {
  try { console.log(check(f)) } catch (e) { console.log(f + ': ERROR ' + e.message) }
}
