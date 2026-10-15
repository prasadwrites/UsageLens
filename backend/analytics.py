"""Historical aggregation over usage_data.yaml snapshots for a single host.

Focused on answering "is the system being used and by whom?" — tracks
login history from `last`, current sessions from `who`, and system load
from `uptime`.
"""

import datetime as dt
import re
import time

from . import storage

RANGE_DAYS = {
    "7d": 7,
    "14d": 14,
    "30d": 30,
    "60d": 60,
    "90d": 90,
}

# In-memory cache: avoids re-parsing the 13MB YAML on every request.
_cache = {"mtime": 0, "data": None}


def _cached_usage():
    """Return usage data, re-loading from disk only if the file changed."""
    import os
    path = storage.USAGE_FILE
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return {"snapshots": []}
    if _cache["data"] is None or mtime > _cache["mtime"]:
        _cache["data"] = storage.load_usage()
        _cache["mtime"] = mtime
    return _cache["data"]


def invalidate_cache():
    _cache["mtime"] = 0
    _cache["data"] = None


def append_to_cache(snapshot):
    """Add a snapshot to the in-memory cache without re-parsing the file."""
    import time as _time
    if _cache["data"] is not None:
        _cache["data"]["snapshots"].append(snapshot)
        _cache["mtime"] = _time.time()


def delete_from_cache(host_id, collected_at):
    """Remove a snapshot from cache and return the updated data for writing.
    Returns (data_dict, was_deleted). Uses cache to avoid re-parsing the file."""
    import time as _time
    data = _cached_usage()
    before = len(data["snapshots"])
    data["snapshots"] = [
        s for s in data["snapshots"]
        if not (s.get("host_id") == host_id and s.get("collected_at") == collected_at)
    ]
    deleted = len(data["snapshots"]) < before
    if deleted:
        _cache["mtime"] = _time.time()
    return data, deleted


def delete_host_from_cache(host_id):
    """Remove all snapshots for a host from cache and return updated data."""
    import time as _time
    data = _cached_usage()
    before = len(data["snapshots"])
    data["snapshots"] = [s for s in data["snapshots"] if s.get("host_id") != host_id]
    removed = before - len(data["snapshots"])
    if removed:
        _cache["mtime"] = _time.time()
    return data, removed


def _parse(ts):
    return dt.datetime.fromisoformat(ts)


# ========== Parsers ==========

def parse_who(who_text):
    sessions = []
    for line in (who_text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 3:
            continue
        user = parts[0]
        terminal = parts[1]
        date_str = parts[2] if len(parts) >= 3 else ""
        time_str = parts[3] if len(parts) >= 4 else ""
        source = parts[4].strip("()") if len(parts) >= 5 else ""
        sessions.append({
            "user": user,
            "terminal": terminal,
            "login_time": f"{date_str} {time_str}".strip(),
            "source": source,
        })
    return sessions


def parse_uptime(uptime_text):
    text = (uptime_text or "").strip()
    result = {"uptime_str": "", "users": 0, "load_1m": 0.0, "load_5m": 0.0, "load_15m": 0.0}
    if not text:
        return result
    m = re.search(r"up\s+(.+?),\s+(\d+)\s+user", text)
    if m:
        result["uptime_str"] = m.group(1).strip()
        result["users"] = int(m.group(2))
    m = re.search(r"load average:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)", text)
    if m:
        result["load_1m"] = float(m.group(1))
        result["load_5m"] = float(m.group(2))
        result["load_15m"] = float(m.group(3))
    return result


_LAST_LINE_RE = re.compile(
    r"^(\S+)\s+(\S+)\s+(\S+(?:\s\S+)*?)\s+"
    r"(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+)\s+"
    r"[-–]\s+"
    r"(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+|(?:\d+:\d+))\s+"
    r"\((.+?)\)"
)

_LAST_STILL_RE = re.compile(
    r"^(\S+)\s+(\S+)\s+(\S+(?:\s\S+)*?)\s+"
    r"(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+)\s+"
    r"still logged in"
)


def _parse_last_datetime(s, ref_year):
    """Parse 'Wed Oct  7 18:52' with a reference year."""
    try:
        parsed = dt.datetime.strptime(s.strip(), "%a %b %d %H:%M")
        return parsed.replace(year=ref_year)
    except ValueError:
        return None


def _parse_duration(dur_str):
    """Parse '(02:01)' or '(1+06:36)' into minutes."""
    dur_str = dur_str.strip()
    m = re.match(r"(\d+)\+(\d+):(\d+)", dur_str)
    if m:
        return int(m.group(1)) * 1440 + int(m.group(2)) * 60 + int(m.group(3))
    m = re.match(r"(\d+):(\d+)", dur_str)
    if m:
        return int(m.group(1)) * 60 + int(m.group(2))
    return 0


def parse_last(last_text, ref_year=None):
    """Parse `last -w` output into login records.

    Returns list of {user, terminal, source, login_dt, logout_dt, duration_min, still_logged_in}.
    """
    if ref_year is None:
        ref_year = dt.datetime.now().year
    records = []
    for line in (last_text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("wtmp") or line.startswith("reboot") or line.startswith("shutdown"):
            continue

        # Try "still logged in" pattern first
        m = _LAST_STILL_RE.match(line)
        if m:
            user, terminal, source, login_str = m.groups()
            login_dt = _parse_last_datetime(login_str, ref_year)
            if login_dt:
                now = dt.datetime.now()
                dur = max(0, int((now - login_dt).total_seconds() / 60))
                records.append({
                    "user": user, "terminal": terminal, "source": source.strip(),
                    "login_dt": login_dt.isoformat(), "logout_dt": None,
                    "duration_min": dur, "still_logged_in": True,
                })
            continue

        # Try normal logout pattern
        m = _LAST_LINE_RE.match(line)
        if m:
            user, terminal, source, login_str, logout_str, dur_str = m.groups()
            login_dt = _parse_last_datetime(login_str, ref_year)
            if login_dt:
                duration_min = _parse_duration(dur_str)
                logout_dt = login_dt + dt.timedelta(minutes=duration_min)
                records.append({
                    "user": user, "terminal": terminal, "source": source.strip(),
                    "login_dt": login_dt.isoformat(), "logout_dt": logout_dt.isoformat(),
                    "duration_min": duration_min, "still_logged_in": False,
                })
            continue

    return records


# ========== Data access ==========

def _all_snapshots_for_host(host_id):
    all_snaps = _cached_usage()["snapshots"]
    snaps = [s for s in all_snaps if s.get("host_id") == host_id and not s.get("error")]
    snaps.sort(key=lambda s: s["collected_at"])
    return snaps


def _snapshots_for_host(host_id, range_key):
    days = RANGE_DAYS.get(range_key, 7)
    now = dt.datetime.now(dt.timezone.utc)
    range_start = now - dt.timedelta(days=days)
    snaps = [s for s in _all_snapshots_for_host(host_id) if _parse(s["collected_at"]) >= range_start]
    return snaps, range_start, now


# ========== Snapshot list / detail ==========

def list_snapshots(host_id):
    snaps = _all_snapshots_for_host(host_id)
    result = []
    for s in snaps:
        who_sessions = parse_who(s.get("who", ""))
        uptime_info = parse_uptime(s.get("uptime", ""))
        last_records = parse_last(s.get("last", ""))
        distinct_users = len(set(sess["user"] for sess in who_sessions))
        result.append({
            "collected_at": s["collected_at"],
            "user_count": distinct_users,
            "session_count": len(who_sessions),
            "load_1m": uptime_info["load_1m"],
            "users_reported": uptime_info["users"],
            "login_records": len(last_records),
        })
    return result


def get_snapshot_detail(host_id, collected_at):
    snaps = _all_snapshots_for_host(host_id)
    snap = next((s for s in snaps if s["collected_at"] == collected_at), None)
    if snap is None:
        return None
    who_sessions = parse_who(snap.get("who", ""))
    uptime_info = parse_uptime(snap.get("uptime", ""))
    last_records = parse_last(snap.get("last", ""))
    return {
        "collected_at": snap["collected_at"],
        "who_sessions": who_sessions,
        "uptime": uptime_info,
        "last_records": last_records,
        "who_raw": snap.get("who", ""),
        "uptime_raw": snap.get("uptime", ""),
        "last_raw": snap.get("last", ""),
        "extra_command_outputs": snap.get("extra_command_outputs", {}),
    }


# ========== Trends from `last` data ==========

def _collect_all_login_records(snaps):
    """Merge login records from the most recent snapshot's `last` output (since `last`
    already contains history, we only need the latest one)."""
    if not snaps:
        return []
    latest = snaps[-1]
    return parse_last(latest.get("last", ""))


def _daily_buckets(snaps, login_records):
    """Build daily stats from login records + uptime data."""
    by_day = {}

    for rec in login_records:
        login_dt = _parse(rec["login_dt"])
        day = rec["login_dt"][:10]
        bucket = by_day.setdefault(day, {
            "date": day, "users": set(), "session_count": 0, "total_minutes": 0,
            "load_1m_values": [], "load_5m_values": [], "load_15m_values": [],
        })
        bucket["users"].add(rec["user"])
        bucket["session_count"] += 1
        bucket["total_minutes"] += rec["duration_min"]

    for snap in snaps:
        day = snap["collected_at"][:10]
        uptime_info = parse_uptime(snap.get("uptime", ""))
        bucket = by_day.setdefault(day, {
            "date": day, "users": set(), "session_count": 0, "total_minutes": 0,
            "load_1m_values": [], "load_5m_values": [], "load_15m_values": [],
        })
        bucket["load_1m_values"].append(uptime_info["load_1m"])
        bucket["load_5m_values"].append(uptime_info["load_5m"])
        bucket["load_15m_values"].append(uptime_info["load_15m"])

    daily = []
    for day in sorted(by_day):
        b = by_day[day]
        avg = lambda vs: round(sum(vs) / len(vs), 2) if vs else 0
        daily.append({
            "date": b["date"],
            "logged_in_users": len(b["users"]),
            "user_names": sorted(b["users"]),
            "session_count": b["session_count"],
            "total_hours": round(b["total_minutes"] / 60, 1),
            "avg_load_1m": avg(b["load_1m_values"]),
            "avg_load_5m": avg(b["load_5m_values"]),
            "avg_load_15m": avg(b["load_15m_values"]),
        })
    return daily


def _heatmap(login_records):
    """Heatmap: hour-of-day x date, cell = number of active sessions during that hour."""
    cells = {}
    dates = set()
    for rec in login_records:
        login_dt = _parse(rec["login_dt"])
        dur_min = rec["duration_min"]
        if dur_min < 1:
            dur_min = 1
        end_dt = login_dt + dt.timedelta(minutes=dur_min)
        current = login_dt.replace(minute=0, second=0, microsecond=0)
        while current < end_dt:
            day = current.strftime("%Y-%m-%d")
            hour = current.hour
            dates.add(day)
            key = (day, hour)
            users = cells.setdefault(key, set())
            users.add(rec["user"])
            current += dt.timedelta(hours=1)

    grid = [{"date": d, "hour": h, "count": len(u)} for (d, h), u in cells.items()]
    max_count = max((c["count"] for c in grid), default=0)
    return {"dates": sorted(dates), "cells": grid, "max_count": max_count}


def _user_summary(login_records):
    by_user = {}
    for rec in login_records:
        user = rec["user"]
        entry = by_user.setdefault(user, {
            "user": user, "first_seen": rec["login_dt"], "last_seen": rec["login_dt"],
            "days_active": set(), "total_sessions": 0, "total_minutes": 0,
            "sources": set(), "still_logged_in": False,
        })
        if rec["login_dt"] < entry["first_seen"]:
            entry["first_seen"] = rec["login_dt"]
        if rec["login_dt"] > entry["last_seen"]:
            entry["last_seen"] = rec["login_dt"]
        entry["days_active"].add(rec["login_dt"][:10])
        entry["total_sessions"] += 1
        entry["total_minutes"] += rec["duration_min"]
        if rec["source"]:
            entry["sources"].add(rec["source"])
        if rec["still_logged_in"]:
            entry["still_logged_in"] = True

    summary = []
    for e in by_user.values():
        summary.append({
            "user": e["user"],
            "first_seen": e["first_seen"][:16],
            "last_seen": e["last_seen"][:16],
            "days_active": len(e["days_active"]),
            "total_sessions": e["total_sessions"],
            "total_hours": round(e["total_minutes"] / 60, 1),
            "sources": sorted(e["sources"]),
            "still_logged_in": e["still_logged_in"],
        })
    summary.sort(key=lambda e: e["total_hours"], reverse=True)
    return summary


def build_history(host_id, range_key):
    snaps, range_start, range_end = _snapshots_for_host(host_id, range_key)

    all_records = _collect_all_login_records(snaps)
    # Filter records to the selected range
    range_start_naive = range_start.replace(tzinfo=None)
    records_in_range = [r for r in all_records if _parse(r["login_dt"]).replace(tzinfo=None) >= range_start_naive]

    daily = _daily_buckets(snaps, records_in_range)

    all_users = set()
    for d in daily:
        all_users.update(d["user_names"])

    busiest = max(daily, key=lambda d: d["logged_in_users"]) if daily else None

    return {
        "range": range_key,
        "range_start": range_start.replace(microsecond=0).isoformat(),
        "range_end": range_end.replace(microsecond=0).isoformat(),
        "snapshot_count": len(snaps),
        "distinct_users": sorted(all_users),
        "busiest_day": busiest["date"] if busiest else None,
        "busiest_day_users": busiest["logged_in_users"] if busiest else 0,
        "daily": daily,
        "heatmap": _heatmap(records_in_range),
        "user_summary": _user_summary(records_in_range),
    }
