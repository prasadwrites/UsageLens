"""Load/save helpers for the YAML-backed data files, with file locking so the
web server and a headless `collector.py --all` cron run can't corrupt each other."""

import os
import re
import yaml
from filelock import FileLock

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
HOSTS_FILE = os.path.join(DATA_DIR, "hosts.yaml")
USAGE_FILE = os.path.join(DATA_DIR, "usage_data.yaml")

os.makedirs(DATA_DIR, exist_ok=True)


def _lock_for(path):
    return FileLock(path + ".lock")


def _load(path, default):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    return data if data is not None else default


def _save(path, data):
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)
    os.replace(tmp_path, path)


def load_hosts():
    with _lock_for(HOSTS_FILE):
        return _load(HOSTS_FILE, {"hosts": []})


def save_hosts(data):
    with _lock_for(HOSTS_FILE):
        _save(HOSTS_FILE, data)


def load_usage():
    with _lock_for(USAGE_FILE):
        return _load(USAGE_FILE, {"snapshots": []})


def save_usage(data):
    with _lock_for(USAGE_FILE):
        _save(USAGE_FILE, data)


def append_snapshot(snapshot):
    """Append a snapshot by writing directly to end of file — avoids loading the full YAML."""
    with _lock_for(USAGE_FILE):
        if not os.path.exists(USAGE_FILE):
            with open(USAGE_FILE, "w", encoding="utf-8") as f:
                f.write("snapshots:\n")
        item_yaml = yaml.safe_dump([snapshot], sort_keys=False, allow_unicode=True)
        with open(USAGE_FILE, "a", encoding="utf-8") as f:
            f.write(item_yaml)
    return snapshot


def delete_all_snapshots_for_host(host_id):
    """Remove all snapshots for a given host."""
    with _lock_for(USAGE_FILE):
        data = _load(USAGE_FILE, {"snapshots": []})
        before = len(data["snapshots"])
        data["snapshots"] = [s for s in data["snapshots"] if s.get("host_id") != host_id]
        removed = before - len(data["snapshots"])
        if removed:
            _save(USAGE_FILE, data)
        return removed


def delete_snapshot(host_id, collected_at):
    """Remove a single snapshot identified by host_id + collected_at."""
    with _lock_for(USAGE_FILE):
        data = _load(USAGE_FILE, {"snapshots": []})
        before = len(data["snapshots"])
        data["snapshots"] = [
            s for s in data["snapshots"]
            if not (s.get("host_id") == host_id and s.get("collected_at") == collected_at)
        ]
        if len(data["snapshots"]) < before:
            _save(USAGE_FILE, data)
            return True
        return False


_HOST_ID_RE = re.compile(r"^\s*host_id:\s*(.+)$")

def snapshot_counts():
    """Count snapshots per host by scanning for host_id lines — much faster than full YAML parse."""
    counts = {}
    if not os.path.exists(USAGE_FILE):
        return counts
    with _lock_for(USAGE_FILE):
        with open(USAGE_FILE, "r", encoding="utf-8") as f:
            for line in f:
                m = _HOST_ID_RE.match(line)
                if m:
                    hid = m.group(1).strip().strip("'\"")
                    counts[hid] = counts.get(hid, 0) + 1
    return counts
