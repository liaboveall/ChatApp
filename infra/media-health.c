/* Fixed one-process socket health check: no shell, decoding or extra Bun thread pool. */
#include <sys/stat.h>

int main(void) {
    struct stat socket;
    return lstat("/run/chatapp-media/media.sock", &socket) != 0 ||
           !S_ISSOCK(socket.st_mode) || socket.st_uid != 10001 ||
           socket.st_gid != 10001 || (socket.st_mode & 0777) != 0600;
}
