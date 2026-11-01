#include "internal.hpp"

namespace mediacore {
namespace {
thread_local std::string g_last_error;
}

void fail(mc_status st, const std::string& msg) { throw Error(st, msg); }
void set_last_error(const std::string& msg) {
  try {
    g_last_error = msg;
  } catch (...) {
  }
}
const char* last_error() noexcept { return g_last_error.c_str(); }
}  // namespace mediacore
