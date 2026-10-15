"""Runs the configured commands for a host over SSH, parses `ps` output into
structured process records, and appends a snapshot to usage_data.yaml.

Also runnable directly as a CLI so it can be scheduled via cron / Task Scheduler
for continuous background collection even when the browser isn't open:

    python -m backend.collector --all
    python -m backend.collector --host-id <id>
"""

import argparse
import datetime as dt
import sys

from . import storage
from .ssh_client import connect, run_command, run_command_via_jump, SSHConnectError

WHO_COMMAND = "who"
UPTIME_COMMAND = "uptime"
LAST_COMMAND = "last -w -500"

BUILTIN_COMMANDS = [WHO_COMMAND, UPTIME_COMMAND, LAST_COMMAND]
DEFAULT_COMMANDS = []


def _now_iso():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def _find_host(hosts, host_id):
    for h in hosts:
        if h["id"] == host_id:
            return h
    return None


def _cmd_label(cmd):
    """Short display name for a command."""
    if cmd.strip() == WHO_COMMAND:
        return "who (current users)"
    if cmd.strip() == UPTIME_COMMAND:
        return "uptime (load)"
    if cmd.strip().startswith("last"):
        return "last (login history)"
    return cmd[:50] + ("…" if len(cmd) > 50 else "")


def collect_for_host(host_cfg, all_hosts, on_progress=None):
    """Connect (optionally via jump host), run built-in + user commands, return a snapshot dict.

    Built-in commands (who, uptime, last) always run silently.
    User commands from host config are extra — their output goes to extra_command_outputs.
    """
    def emit(step, total, msg):
        if on_progress:
            on_progress(step, total, msg)

    collected_at = _now_iso()

    jump_cfg = None
    if host_cfg.get("jump_enabled") and host_cfg.get("jump_hostname"):
        jump_cfg = {
            "hostname": host_cfg["jump_hostname"],
            "port": host_cfg.get("jump_port") or 22,
            "username": host_cfg.get("jump_username") or "",
            "auth_method": host_cfg.get("jump_auth_method") or "identity_file",
            "identity_file": host_cfg.get("jump_identity_file"),
            "password": host_cfg.get("jump_password"),
        }

    user_commands = [c for c in (host_cfg.get("commands") or []) if c.strip()]
    all_commands = list(BUILTIN_COMMANDS) + user_commands
    total_steps = 1 + len(all_commands) + 1

    client = None
    jump_client = None
    jump_alias = host_cfg.get("jump_alias")
    use_jump_alias = bool(jump_cfg and jump_alias)

    try:
        if jump_cfg:
            emit(1, total_steps, f"Connecting to jump host ({jump_cfg['hostname']})…")
        else:
            emit(1, total_steps, f"Connecting to {host_cfg.get('name', host_cfg['hostname'])}…")
        client, jump_client = connect(host_cfg, jump_host_cfg=jump_cfg)
        if use_jump_alias:
            emit(1, total_steps, f"Connected via jump host — target alias '{jump_alias}'")

        who_out = ""
        uptime_out = ""
        last_out = ""
        extra_outputs = {}

        def _run(cmd):
            if use_jump_alias:
                return run_command_via_jump(client, jump_alias, cmd)
            return run_command(client, cmd)

        for i, cmd in enumerate(all_commands):
            step = 2 + i
            emit(step, total_steps, f"Running {i + 1}/{len(all_commands)}: {_cmd_label(cmd)}")
            exit_code, out, err = _run(cmd)
            if cmd.strip() == WHO_COMMAND:
                who_out = out
            elif cmd.strip() == UPTIME_COMMAND:
                uptime_out = out
            elif cmd.strip().startswith("last"):
                last_out = out
            else:
                extra_outputs[cmd] = out if exit_code == 0 else f"[exit {exit_code}] {out}{err}"

        emit(total_steps, total_steps, "Saving snapshot…")

        return {
            "host_id": host_cfg["id"],
            "collected_at": collected_at,
            "who": who_out,
            "uptime": uptime_out,
            "last": last_out,
            "extra_command_outputs": extra_outputs,
            "error": None,
        }
    except SSHConnectError as exc:
        return {
            "host_id": host_cfg["id"],
            "collected_at": collected_at,
            "who": "",
            "uptime": "",
            "last": "",
            "extra_command_outputs": {},
            "error": str(exc),
        }
    finally:
        if client is not None:
            client.close()
        if jump_client is not None:
            jump_client.close()


def collect_and_store(host_id):
    hosts = storage.load_hosts()["hosts"]
    host_cfg = _find_host(hosts, host_id)
    if host_cfg is None:
        raise ValueError(f"No such host: {host_id}")
    snapshot = collect_for_host(host_cfg, hosts)
    storage.append_snapshot(snapshot)
    return snapshot


def main():
    parser = argparse.ArgumentParser(description="Collect SSH usage snapshots")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--all", action="store_true", help="collect for every configured host")
    group.add_argument("--host-id", help="collect for a single host id")
    args = parser.parse_args()

    hosts = storage.load_hosts()["hosts"]
    if not hosts:
        print("No hosts configured in data/hosts.yaml", file=sys.stderr)
        return 1

    targets = hosts if args.all else [h for h in hosts if h["id"] == args.host_id]
    if not targets:
        print(f"No host with id {args.host_id}", file=sys.stderr)
        return 1

    for host_cfg in targets:
        snapshot = collect_for_host(host_cfg, hosts)
        storage.append_snapshot(snapshot)
        status = "ERROR: " + snapshot["error"] if snapshot["error"] else f"{len(snapshot['processes'])} processes"
        print(f"[{host_cfg.get('name', host_cfg['id'])}] {status}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
