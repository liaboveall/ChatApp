"""Build-stage only: copy an ELF dependency closure and its Debian package inventory.

Distroless supplies libc/libgcc/libstdc++; extra libraries keep scanner-visible
package records instead of disappearing from the vulnerability inventory.
"""
import pathlib
import re
import shutil
import subprocess
import sys

destination = pathlib.Path(sys.argv[1])
base_packages = {"libc6", "libgcc-s1", "libstdc++6"}
packages = set()


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def owner(path):
    merged_alias = pathlib.Path(str(path)[4:]) if str(path).startswith(("/usr/bin/", "/usr/sbin/", "/usr/lib/")) else path
    for candidate in dict.fromkeys([path, path.resolve(), merged_alias]):
        try:
            result = command("dpkg-query", "-S", str(candidate))
        except subprocess.CalledProcessError:
            continue
        entries = [
            match.group(1)
            for line in result.splitlines()
            if (match := re.match(r"^([a-z0-9][a-z0-9+.-]*)(?::[a-z0-9]+)?: /", line))
        ]
        if len(set(entries)) == 1:
            return entries[0]
    raise SystemExit(f"unambiguous Debian package owner required: {path}")


def copy(path):
    package = owner(path)
    if package in base_packages:
        return
    packages.add(package)
    location = str(path)
    # Distroless uses merged /usr aliases. A /lib directory would overwrite its symlink.
    if location.startswith(("/lib/", "/lib64/", "/bin/", "/sbin/")):
        location = "/usr" + location
    target = destination / location.lstrip("/")
    target.parent.mkdir(parents=True, exist_ok=True)
    # Keep the SONAME path used by the loader, with regular bytes rather than a broken symlink.
    shutil.copy2(path, target, follow_symlinks=True)


for argument in sys.argv[2:]:
    path = pathlib.Path(argument)
    if not path.is_absolute() or not path.is_file():
        raise SystemExit("absolute regular ELF input required")
    copy(path)
    result = command("ldd", str(path))
    if "not found" in result:
        raise SystemExit("unresolved runtime library")
    for dependency in re.findall(r"(?:=>\s+|^\s*)(/[^\s]+)", result, re.MULTILINE):
        copy(pathlib.Path(dependency))

inventory = destination / "var/lib/dpkg/status.d"
inventory.mkdir(parents=True, exist_ok=True)
for package in sorted(packages):
    (inventory / package).write_text(command("dpkg-query", "-s", package) + "\n")
    notices = pathlib.Path("/usr/share/doc") / package
    if notices.exists():
        shutil.copytree(notices, destination / "usr/share/doc" / package, dirs_exist_ok=True)
