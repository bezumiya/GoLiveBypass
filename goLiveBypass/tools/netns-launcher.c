#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <pwd.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/types.h>
#include <unistd.h>

static int fail_message(const char *message) {
    fprintf(stderr, "netns-launcher: %s: %s\n", message, strerror(errno));
    return 126;
}

static int valid_component(const char *value) {
    size_t length;
    if (value == NULL || value[0] == '\0') return 0;
    length = strlen(value);
    if (length > 31 || value[0] == '.' || value[length - 1] == '.') return 0;
    for (size_t index = 0; index < length; index++) {
        unsigned char character = (unsigned char)value[index];
        if (!(character == '_' || character == '-' ||
              (character >= 'a' && character <= 'z') ||
              (character >= 'A' && character <= 'Z') ||
              (character >= '0' && character <= '9'))) return 0;
    }
    return 1;
}

static int parse_id(const char *value, uid_t *result) {
    char *end = NULL;
    unsigned long parsed;
    if (value == NULL || value[0] == '\0') return 0;
    errno = 0;
    parsed = strtoul(value, &end, 10);
    if (errno != 0 || end == value || *end != '\0' || parsed > (unsigned long)UINT_MAX) return 0;
    *result = (uid_t)parsed;
    return 1;
}

static int set_explicit_environment(int argc, char **argv, int first, int end) {
    for (int index = first; index < end; index++) {
        const char *entry = argv[index];
        const char *separator;
        if (strncmp(entry, "--env=", 6) != 0) return 0;
        separator = strchr(entry + 6, '=');
        if (separator == NULL || separator == entry + 6) return 0;
        for (const char *cursor = entry + 6; cursor < separator; cursor++) {
            unsigned char character = (unsigned char)*cursor;
            if (cursor == entry + 6) {
                if (!(character == '_' ||
                      (character >= 'A' && character <= 'Z') ||
                      (character >= 'a' && character <= 'z'))) return 0;
            } else if (!(character == '_' || (character >= 'A' && character <= 'Z') ||
                         (character >= 'a' && character <= 'z') ||
                         (character >= '0' && character <= '9'))) return 0;
        }
        if (setenv(entry + 6, separator + 1, 1) != 0) return 0;
    }
    (void)argc;
    return 1;
}

static int configure_namespace_mounts(const char *namespace) {
    char resolv_path[PATH_MAX];
    if (snprintf(resolv_path, sizeof(resolv_path), "/etc/netns/%s/resolv.conf", namespace) >= (int)sizeof(resolv_path)) {
        errno = ENAMETOOLONG;
        return fail_message("caminho do DNS grande demais");
    }
    if (access(resolv_path, R_OK) != 0) {
        if (errno == ENOENT) return 0;
        return fail_message("não foi possível ler o DNS privado");
    }
    if (unshare(CLONE_NEWNS) != 0) return fail_message("não foi possível separar os mounts do cliente");
    if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0)
        return fail_message("não foi possível isolar os mounts do cliente");
    if (mount(resolv_path, "/etc/resolv.conf", NULL, MS_BIND, NULL) != 0)
        return fail_message("não foi possível aplicar o DNS privado do namespace");
    return 0;
}

static int self_delete_launcher(const char *path) {
    if (unlink(path) == 0 || errno == ENOENT) return 0;
    return fail_message("não foi possível remover o launcher temporário");
}

int main(int argc, char **argv) {
    char namespace_path[PATH_MAX];
    uid_t uid;
    uid_t gid;
    int namespace_fd;
    int separator = 4;
    int environment_start = 4;
    int delete_after_start = 0;
    struct passwd *account;

    if (argc < 6 || !valid_component(argv[1]) || !parse_id(argv[2], &uid) || !parse_id(argv[3], &gid)) {
        errno = EINVAL;
        return fail_message("argumentos inválidos");
    }
    if (strcmp(argv[environment_start], "--self-delete") == 0) {
        delete_after_start = 1;
        environment_start++;
        separator = environment_start;
    }
    while (separator < argc && strcmp(argv[separator], "--") != 0) separator++;
    if (separator >= argc || separator + 1 >= argc) {
        errno = EINVAL;
        return fail_message("comando ausente");
    }
    if (snprintf(namespace_path, sizeof(namespace_path), "/run/netns/%s", argv[1]) >= (int)sizeof(namespace_path)) {
        errno = ENAMETOOLONG;
        return fail_message("nome de namespace grande demais");
    }

    if (delete_after_start && self_delete_launcher(argv[0]) != 0) return 126;

    namespace_fd = open(namespace_path, O_RDONLY | O_CLOEXEC);
    if (namespace_fd < 0) return fail_message("não foi possível abrir o namespace");
    if (setns(namespace_fd, CLONE_NEWNET) != 0) {
        int saved_errno = errno;
        close(namespace_fd);
        errno = saved_errno;
        return fail_message("não foi possível entrar no namespace");
    }
    close(namespace_fd);

    if (configure_namespace_mounts(argv[1]) != 0) return 126;
    if (clearenv() != 0) return fail_message("não foi possível limpar o ambiente");
    if (!set_explicit_environment(argc, argv, environment_start, separator)) {
        errno = EINVAL;
        return fail_message("ambiente explícito inválido");
    }

    account = getpwuid(uid);
    if (account != NULL) {
        if (initgroups(account->pw_name, gid) != 0) return fail_message("não foi possível preparar grupos do usuário");
    } else if (setgroups(0, NULL) != 0) {
        return fail_message("não foi possível limpar grupos suplementares");
    }
    if (setgid(gid) != 0 || setuid(uid) != 0) return fail_message("não foi possível abandonar privilégios administrativos");
    if (geteuid() != uid || getegid() != gid) {
        errno = EPERM;
        return fail_message("o processo não abandonou privilégios administrativos");
    }

    execv(argv[separator + 1], &argv[separator + 1]);
    return fail_message("não foi possível iniciar o cliente");
}
