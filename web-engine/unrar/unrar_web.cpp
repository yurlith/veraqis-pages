// VERAQIS web — UnRAR for the browser.
//
// One entry point, rar_run(), drives the UnRAR library's documented DLL API
// (dll.hpp) in three modes and answers with JSON:
//
//   list     every entry with its sizes, checksum, flags and time
//   test     decompress every entry and check its CRC32/BLAKE2, write nothing
//   extract  write entries (all, or the selected ones) under a destination
//            directory; an entry that fails its checksum is not kept
//
// Passwords are only ever the one the user typed for this call; nothing is
// guessed or remembered. Missing volumes and missing passwords are reported,
// never worked around. This file is a thin adapter: all RAR parsing,
// decompression and checking is UnRAR's own code (see license below).
//
// SPDX-License-Identifier: MIT OR Apache-2.0  (this adapter only)
// UnRAR itself: "UnRAR source code may be used in any software to handle RAR
// archives without limitations free of charge, but cannot be used to develop
// RAR (WinRAR) compatible archiver and to re-create RAR compression algorithm,
// which is proprietary. Distribution of modified UnRAR source code in separate
// form or as a part of other software is permitted, provided that full text of
// this paragraph, starting from "UnRAR source code" words, is included in
// license, or in documentation if license is not available, and in source code
// comments of resulting package."

#include "rar.hpp"

#include <set>
#include <string>

namespace {

struct Ctx {
  std::wstring password;
  bool have_password = false;
  bool needed_password = false;
  bool missing_volume = false;
  std::string missing_volume_name;
  bool large_dict_refused = false;
  unsigned long long bytes = 0;
};

std::string g_result;  // returned to JavaScript; valid until the next call

void esc(std::string &o, const std::string &s) {
  o += '"';
  for (unsigned char ch : s) {
    switch (ch) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (ch < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", ch); o += b; }
        else o += (char)ch;
    }
  }
  o += '"';
}

std::string utf8(const wchar_t *w) {
  std::string out;
  if (!w) return out;
  size_t n = wcslen(w) * 4 + 4;
  std::vector<char> buf(n);
  WideToUtf(w, buf.data(), n);
  out = buf.data();
  return out;
}

std::wstring wide(const char *s) {
  size_t n = strlen(s) + 1;
  std::vector<wchar_t> buf(n);
  UtfToWide(s, buf.data(), n);
  return std::wstring(buf.data());
}

const char *code_text(int r) {
  switch (r) {
    case 0: return "ok";
    case ERAR_END_ARCHIVE: return "end of archive";
    case ERAR_NO_MEMORY: return "not enough memory";
    case ERAR_BAD_DATA: return "checksum error: data is damaged (or the password is wrong)";
    case ERAR_BAD_ARCHIVE: return "not a valid RAR archive";
    case ERAR_UNKNOWN_FORMAT: return "unknown archive format";
    case ERAR_EOPEN: return "cannot open the archive or a volume";
    case ERAR_ECREATE: return "cannot create an output file";
    case ERAR_ECLOSE: return "cannot close a file";
    case ERAR_EREAD: return "read error";
    case ERAR_EWRITE: return "write error";
    case ERAR_SMALL_BUF: return "buffer too small";
    case ERAR_UNKNOWN: return "unknown error";
    case ERAR_MISSING_PASSWORD: return "a password is required";
    case ERAR_EREFERENCE: return "cannot open a file this entry refers to";
    case ERAR_BAD_PASSWORD: return "wrong password";
    case ERAR_LARGE_DICT: return "dictionary larger than this build allows";
    default: return "error";
  }
}

int CALLBACK callback(UINT msg, LPARAM user, LPARAM p1, LPARAM p2) {
  Ctx *c = reinterpret_cast<Ctx *>(user);
  switch (msg) {
    case UCM_PROCESSDATA:
      c->bytes += (unsigned long long)p2;
      return 1;
    case UCM_NEEDPASSWORDW:
      if (!c->have_password) { c->needed_password = true; return -1; }
      wcsncpyz(reinterpret_cast<wchar_t *>(p1), c->password.c_str(), (size_t)p2);
      return 1;
    case UCM_NEEDPASSWORD: {
      if (!c->have_password) { c->needed_password = true; return -1; }
      std::string pw = utf8(c->password.c_str());
      strncpyz(reinterpret_cast<char *>(p1), pw.c_str(), (size_t)p2);
      return 1;
    }
    case UCM_CHANGEVOLUMEW:
      if (p2 == RAR_VOL_ASK) {
        c->missing_volume = true;
        c->missing_volume_name = utf8(reinterpret_cast<wchar_t *>(p1));
        return -1;
      }
      return 1;
    case UCM_CHANGEVOLUME:
      if (p2 == RAR_VOL_ASK) {
        c->missing_volume = true;
        c->missing_volume_name = reinterpret_cast<char *>(p1);
        return -1;
      }
      return 1;
    case UCM_LARGEDICT:
      c->large_dict_refused = true;
      return 0;
  }
  return 0;
}

std::string hex(const unsigned char *p, size_t n) {
  static const char *d = "0123456789abcdef";
  std::string s;
  for (size_t i = 0; i < n; i++) { s += d[p[i] >> 4]; s += d[p[i] & 15]; }
  return s;
}

}  // namespace

extern "C" {

// mode: "list" | "test" | "extract". dest: output directory (extract only).
// password: UTF-8 or empty. selected: '\n'-separated entry names to extract,
// or empty for every entry.
const char *rar_run(const char *mode_c, const char *archive, const char *dest,
                    const char *password, const char *selected) {
  const std::string mode = mode_c ? mode_c : "";
  const bool list = mode == "list";
  const bool extract = mode == "extract";
  Ctx ctx;
  if (password && *password) { ctx.password = wide(password); ctx.have_password = true; }

  std::set<std::string> want;
  if (extract && selected && *selected) {
    std::string s(selected), cur;
    for (char ch : s) { if (ch == '\n') { if (!cur.empty()) want.insert(cur); cur.clear(); } else cur += ch; }
    if (!cur.empty()) want.insert(cur);
  }
  std::wstring destw = extract && dest ? wide(dest) : std::wstring();

  RAROpenArchiveDataEx od{};
  od.ArcName = const_cast<char *>(archive);
  od.OpenMode = list ? RAR_OM_LIST : RAR_OM_EXTRACT;
  od.Callback = callback;
  od.UserData = reinterpret_cast<LPARAM>(&ctx);

  std::string o = "{\"mode\":";
  esc(o, mode);
  HANDLE h = RAROpenArchiveEx(&od);
  if (!h) {
    int r = (int)od.OpenResult;
    if (ctx.needed_password) r = ERAR_MISSING_PASSWORD;
    o += ",\"ok\":false,\"error_code\":" + std::to_string(r) + ",\"error\":";
    esc(o, code_text(r));
    o += ",\"need_password\":" + std::string(ctx.needed_password ? "true" : "false") + ",\"entries\":[]}";
    g_result = o;
    return g_result.c_str();
  }
  const unsigned f = od.Flags;
  o += ",\"archive\":{\"volume\":" + std::string(f & ROADF_VOLUME ? "true" : "false") +
       ",\"first_volume\":" + std::string(f & ROADF_FIRSTVOLUME ? "true" : "false") +
       ",\"solid\":" + std::string(f & ROADF_SOLID ? "true" : "false") +
       ",\"recovery_record\":" + std::string(f & ROADF_RECOVERY ? "true" : "false") +
       ",\"encrypted_headers\":" + std::string(f & ROADF_ENCHEADERS ? "true" : "false") +
       ",\"locked\":" + std::string(f & ROADF_LOCK ? "true" : "false") +
       ",\"signed\":" + std::string(f & ROADF_SIGNED ? "true" : "false") +
       ",\"comment\":" + std::string(f & ROADF_COMMENT ? "true" : "false") + "}";
  if (ctx.have_password) RARSetPassword(h, const_cast<char *>(password));

  o += ",\"entries\":[";
  RARHeaderDataEx hd{};
  int r = 0, n = 0, failed = 0, done = 0;
  unsigned long long total = 0;
  while ((r = RARReadHeaderEx(h, &hd)) == 0) {
    const std::string name = utf8(hd.FileNameW);
    const bool dir = hd.Flags & RHDF_DIRECTORY;
    int pr;
    bool acted = false;
    ctx.bytes = 0;
    if (list) {
      pr = RARProcessFile(h, RAR_SKIP, nullptr, nullptr);
    } else if (extract) {
      acted = want.empty() || want.count(name) > 0;
      pr = acted ? RARProcessFileW(h, RAR_EXTRACT, const_cast<wchar_t *>(destw.c_str()), nullptr)
                 : RARProcessFile(h, RAR_SKIP, nullptr, nullptr);
    } else {
      acted = !dir;
      pr = acted ? RARProcessFile(h, RAR_TEST, nullptr, nullptr)
                 : RARProcessFile(h, RAR_SKIP, nullptr, nullptr);
    }
    if (n++) o += ',';
    unsigned long long size = ((unsigned long long)hd.UnpSizeHigh << 32) | hd.UnpSize;
    unsigned long long packed = ((unsigned long long)hd.PackSizeHigh << 32) | hd.PackSize;
    unsigned long long ft = ((unsigned long long)hd.MtimeHigh << 32) | hd.MtimeLow;
    long long mtime = ft ? (long long)(ft / 10000000ULL) - 11644473600LL : 0;
    char crc[12];
    snprintf(crc, sizeof crc, "%08x", hd.FileCRC);
    o += "{\"name\":";
    esc(o, name);
    o += ",\"dir\":" + std::string(dir ? "true" : "false") +
         ",\"size\":" + std::to_string(size) + ",\"packed\":" + std::to_string(packed) +
         ",\"crc32\":\"" + std::string(crc) + "\"";
    if (hd.HashType == RAR_HASH_BLAKE2) o += ",\"blake2sp\":\"" + hex(reinterpret_cast<unsigned char *>(hd.Hash), 32) + "\"";
    o += ",\"encrypted\":" + std::string(hd.Flags & RHDF_ENCRYPTED ? "true" : "false") +
         ",\"split_before\":" + std::string(hd.Flags & RHDF_SPLITBEFORE ? "true" : "false") +
         ",\"split_after\":" + std::string(hd.Flags & RHDF_SPLITAFTER ? "true" : "false") +
         ",\"link\":" + std::to_string(hd.RedirType) + ",\"mtime\":" + std::to_string(mtime) +
         ",\"method\":" + std::to_string(hd.Method) + ",\"unpack_version\":" + std::to_string(hd.UnpVer);
    if (!list) {
      o += ",\"processed\":" + std::string(acted ? "true" : "false") +
           ",\"result_code\":" + std::to_string(pr) + ",\"result\":";
      esc(o, code_text(pr));
      if (acted && !dir) { done++; if (pr != 0) failed++; total += ctx.bytes; }
    }
    o += "}";
    if (pr != 0) { if (pr == ERAR_MISSING_PASSWORD || pr == ERAR_BAD_PASSWORD || ctx.missing_volume) break; }
    if (ctx.missing_volume) break;
  }
  RARCloseArchive(h);
  o += "]";
  const bool clean_end = r == ERAR_END_ARCHIVE;
  int err = clean_end ? 0 : r;
  if (ctx.missing_volume) err = ERAR_EOPEN;
  if (ctx.needed_password) err = ERAR_MISSING_PASSWORD;
  o += ",\"ok\":" + std::string(clean_end && failed == 0 && !ctx.missing_volume && !ctx.needed_password ? "true" : "false") +
       ",\"entries_total\":" + std::to_string(n) + ",\"entries_processed\":" + std::to_string(done) +
       ",\"entries_failed\":" + std::to_string(failed) + ",\"bytes\":" + std::to_string(total) +
       ",\"error_code\":" + std::to_string(err) + ",\"error\":";
  if (err) esc(o, code_text(err)); else o += "null";
  o += ",\"need_password\":" + std::string(ctx.needed_password ? "true" : "false") + ",\"missing_volume\":";
  if (ctx.missing_volume) esc(o, ctx.missing_volume_name); else o += "null";
  o += ",\"large_dictionary_refused\":" + std::string(ctx.large_dict_refused ? "true" : "false") + "}";
  g_result = o;
  return g_result.c_str();
}

}  // extern "C"
