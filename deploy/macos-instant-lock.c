#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <dlfcn.h>
#include <errno.h>
#include <pwd.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

typedef int (*SACLockScreenImmediateFn)(void);

static bool query_session_state(bool *out_has_session, bool *out_on_console) {
  if (out_has_session) *out_has_session = false;
  if (out_on_console) *out_on_console = false;

  CFDictionaryRef dict = CGSessionCopyCurrentDictionary();
  if (!dict) {
    return false;
  }
  if (out_has_session) *out_has_session = true;

  bool locked = false;
  CFTypeRef lockedVal = CFDictionaryGetValue(dict, CFSTR("CGSSessionScreenIsLocked"));
  if (lockedVal && CFGetTypeID(lockedVal) == CFBooleanGetTypeID()) {
    locked = CFBooleanGetValue((CFBooleanRef)lockedVal);
  }

  if (out_on_console) {
    CFTypeRef consoleVal = CFDictionaryGetValue(dict, CFSTR("kCGSSessionOnConsoleKey"));
    if (!consoleVal) {
      consoleVal = CFDictionaryGetValue(dict, CFSTR("CGSSessionOnConsoleKey"));
    }
    if (consoleVal && CFGetTypeID(consoleVal) == CFBooleanGetTypeID()) {
      *out_on_console = CFBooleanGetValue((CFBooleanRef)consoleVal);
    }
  }

  CFRelease(dict);
  return locked;
}

static FILE *open_log_file(void) {
  const char *home = getenv("HOME");
  if (!home || !home[0]) {
    struct passwd *pw = getpwuid(getuid());
    if (pw) home = pw->pw_dir;
  }
  if (!home || !home[0]) return NULL;

  char log_dir[1024];
  snprintf(log_dir, sizeof(log_dir), "%s/Library/Logs", home);
  mkdir(log_dir, 0755);

  char log_path[1024];
  snprintf(log_path, sizeof(log_path), "%s/macos-instant-lock.log", log_dir);
  return fopen(log_path, "a");
}

static void write_log(FILE *fp, const char *msg) {
  time_t now = time(NULL);
  struct tm tm_now;
  localtime_r(&now, &tm_now);
  char ts[64];
  strftime(ts, sizeof(ts), "%Y-%m-%dT%H:%M:%S%z", &tm_now);

  fprintf(stderr, "[%s] %s\n", ts, msg);
  if (fp) {
    fprintf(fp, "[%s] %s\n", ts, msg);
    fflush(fp);
  }
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--status") == 0) {
    bool has_session = false;
    bool on_console = false;
    bool locked = query_session_state(&has_session, &on_console);
    printf("session=%d console=%d locked=%d\n",
           has_session ? 1 : 0,
           on_console ? 1 : 0,
           locked ? 1 : 0);
    return 0;
  }

  FILE *log_fp = open_log_file();

  const char *candidates[] = {
      "/System/Library/PrivateFrameworks/login.framework/Versions/Current/login",
      "/System/Library/PrivateFrameworks/login.framework/login",
      "/System/Library/PrivateFrameworks/Login.framework/Versions/Current/Login",
      NULL,
  };

  void *handle = NULL;
  for (int i = 0; candidates[i] != NULL; i++) {
    handle = dlopen(candidates[i], RTLD_NOW);
    if (handle) break;
  }
  if (!handle) {
    char buf[512];
    snprintf(buf, sizeof(buf), "ERROR: failed to dlopen login.framework: %s", dlerror());
    write_log(log_fp, buf);
    if (log_fp) fclose(log_fp);
    return 2;
  }

  SACLockScreenImmediateFn lock_fn =
      (SACLockScreenImmediateFn)dlsym(handle, "SACLockScreenImmediate");
  if (!lock_fn) {
    char buf[512];
    snprintf(buf, sizeof(buf), "ERROR: SACLockScreenImmediate symbol missing: %s", dlerror());
    write_log(log_fp, buf);
    if (log_fp) fclose(log_fp);
    return 3;
  }

  write_log(log_fp, "Starting Auto-Login instant screen lock sequence");

  int consecutive_locked = 0;
  int lock_calls = 0;
  const int max_attempts = 80; /* 80 * 150ms = 12.0s window across WindowServer bringup */

  for (int attempt = 0; attempt < max_attempts; attempt++) {
    bool has_session = false;
    bool on_console = false;
    bool locked = query_session_state(&has_session, &on_console);

    if (lock_calls > 0 && has_session && locked) {
      consecutive_locked++;
      if (consecutive_locked >= 2) {
        char ok_msg[256];
        snprintf(ok_msg, sizeof(ok_msg),
                 "CONFIRMED: GUI screen is locked (CGSSessionScreenIsLocked=1, calls=%d, attempt=%d, console=%d)",
                 lock_calls, attempt + 1, on_console ? 1 : 0);
        write_log(log_fp, ok_msg);
        if (log_fp) fclose(log_fp);
        return 0;
      }
    } else {
      consecutive_locked = 0;
      int rc = lock_fn();
      lock_calls++;
      if (lock_calls == 1 || (attempt + 1) % 10 == 0) {
        char step_msg[256];
        snprintf(step_msg, sizeof(step_msg),
                 "Invoked SACLockScreenImmediate() rc=%d (attempt=%d, session=%d, console=%d, was_locked=%d)",
                 rc, attempt + 1, has_session ? 1 : 0, on_console ? 1 : 0, locked ? 1 : 0);
        write_log(log_fp, step_msg);
      }
    }

    usleep(150 * 1000);
  }

  bool final_session = false;
  bool final_console = false;
  bool final_locked = query_session_state(&final_session, &final_console);
  char end_msg[256];
  snprintf(end_msg, sizeof(end_msg),
           "%s: finished after %d calls (session=%d, console=%d, CGSSessionScreenIsLocked=%d)",
           final_locked ? "CONFIRMED" : "WARN",
           lock_calls,
           final_session ? 1 : 0,
           final_console ? 1 : 0,
           final_locked ? 1 : 0);
  write_log(log_fp, end_msg);
  if (log_fp) fclose(log_fp);
  return final_locked ? 0 : 1;
}
