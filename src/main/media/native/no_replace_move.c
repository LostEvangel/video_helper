#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>

/* Exit codes are consumed by src/main/media/publish.ts. */
int wmain(int argc, wchar_t **argv) {
  if (argc != 3) {
    fputs("Usage: no-replace-move.exe <source> <destination>\n", stderr);
    return 64;
  }

  if (MoveFileW(argv[1], argv[2])) {
    return 0;
  }

  const DWORD error = GetLastError();
  if (error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS) {
    fprintf(stderr, "MoveFileW refused to replace the destination (Win32 error %lu).\n", (unsigned long)error);
    return 2;
  }
  if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
    fprintf(stderr, "MoveFileW could not find the source or destination directory (Win32 error %lu).\n", (unsigned long)error);
    return 3;
  }

  fprintf(stderr, "MoveFileW failed (Win32 error %lu).\n", (unsigned long)error);
  return 1;
}
