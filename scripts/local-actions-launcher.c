// SPDX-License-Identifier: BUSL-1.1

#define _DEFAULT_SOURCE

#include <errno.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef OSF_SUPERVISOR_PATH
#error "OSF_SUPERVISOR_PATH must be fixed at compile time"
#endif

#ifndef OSF_RUNNER_HOME
#error "OSF_RUNNER_HOME must be fixed at compile time"
#endif

#ifndef OSF_RUNNER_UID
#error "OSF_RUNNER_UID must be fixed at compile time"
#endif

#define OSF_LAUNCHER_INTERFACE "slot-argument-v1"
#define OSF_BASH_PATH "/bin/bash"

struct preserved_variable {
  const char *name;
  char *value;
};

static bool valid_slot(const char *value) {
  char *end = NULL;
  unsigned long slot;

  if (value == NULL || value[0] < '1' || value[0] > '9') {
    return false;
  }
  for (const char *character = value + 1; *character != '\0'; character++) {
    if (*character < '0' || *character > '9') {
      return false;
    }
  }

  errno = 0;
  slot = strtoul(value, &end, 10);
  return errno == 0 && end != value && *end == '\0' && slot <= UINT_MAX;
}

static int preserve_environment(struct preserved_variable *variables,
                                size_t count) {
  for (size_t index = 0; index < count; index++) {
    const char *value = getenv(variables[index].name);
    if (value != NULL) {
      variables[index].value = strdup(value);
      if (variables[index].value == NULL) {
        perror("strdup");
        return -1;
      }
    }
  }
  return 0;
}

static char *environment_entry(const char *name, const char *value) {
  const size_t length = strlen(name) + strlen(value) + 2;
  char *entry = malloc(length);
  if (entry == NULL) {
    return NULL;
  }
  snprintf(entry, length, "%s=%s", name, value);
  return entry;
}

int main(int argc, char *argv[]) {
  struct preserved_variable variables[] = {
      {"OPENSHAPEFORGE_RUNNER_ISOLATION_GROUP", NULL},
      {"OPENSHAPEFORGE_RUNNER_NAME_PREFIX", NULL},
      {"OPENSHAPEFORGE_DEPLOY_RUNNER_PREFIX", NULL},
      {"OPENSHAPEFORGE_RUNNER_SLOT_COUNT", NULL},
      {"OPENSHAPEFORGE_RUNNER_HOST_CPU_LIMIT", NULL},
      {"OPENSHAPEFORGE_RUNNER_HOST_MEMORY_GIB_LIMIT", NULL},
  };
  const size_t variable_count = sizeof(variables) / sizeof(variables[0]);

  if (getuid() != (uid_t)OSF_RUNNER_UID) {
    fputs("Runner launcher may only be used by its configured operator\n",
          stderr);
    return 77;
  }
  if (argc == 2 && strcmp(argv[1], "--print-egid") == 0) {
    printf("%u:%s\n", (unsigned int)getegid(), OSF_LAUNCHER_INTERFACE);
    return 0;
  }
  if (argc != 2 || !valid_slot(argv[1])) {
    fputs("Runner launcher requires exactly one positive numeric slot\n",
          stderr);
    return 64;
  }
  if (preserve_environment(variables, variable_count) != 0) {
    return 70;
  }

  char *const supervisor_argv[] = {
      OSF_BASH_PATH,
      "-p",
      OSF_SUPERVISOR_PATH,
      "supervise-slot",
      argv[1],
      NULL,
  };
  char home_environment[] = "HOME=" OSF_RUNNER_HOME;
  char path_environment[] =
      "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  char *supervisor_environment[variable_count + 3];
  size_t environment_count = 0;
  supervisor_environment[environment_count++] = home_environment;
  supervisor_environment[environment_count++] = path_environment;
  for (size_t index = 0; index < variable_count; index++) {
    if (variables[index].value == NULL) {
      continue;
    }
    supervisor_environment[environment_count] =
        environment_entry(variables[index].name, variables[index].value);
    if (supervisor_environment[environment_count] == NULL) {
      perror("malloc");
      return 70;
    }
    environment_count++;
  }
  supervisor_environment[environment_count] = NULL;

  execve(OSF_BASH_PATH, supervisor_argv, supervisor_environment);
  perror("Could not execute the fixed runner supervisor");
  return 71;
}
