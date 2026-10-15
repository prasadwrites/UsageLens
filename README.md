# UsageLens

SSH-based system usage dashboard. Add rented Linux hosts (including jump hosts),
collect `ps`/`who`/`uptime` plus any custom commands (Slurm's `sinfo`/`squeue`/`sacct`,
etc.) over SSH, and visualize who ran what and when. All collected data is
persisted to `data/usage_data.yaml`; the page loads from that file on start, so
no SSH call is needed just to view previously collected data.

## Setup

```bash
pip install -r requirements.txt
```

## Run

```bash
uvicorn backend.server:app --reload --port 8000
```

Open `http://localhost:8000`.

## Usage

1. **Add a host**: name, hostname/IP, port, username, and either an identity
   file path or a password. Check "This host is a jump host" for hosts you'll
   route through, and pick a jump host from the dropdown on any host behind one
   — UsageLens will hop through it (equivalent to `ssh -J`) before collecting.
2. Edit the **commands** list for a host to add anything beyond the default
   `ps`/`who`/`uptime` — e.g. `sinfo -a`, `squeue -u someuser`, `sacct --format=...`.
   Output from any command other than the built-in three is shown verbatim in
   the dashboard's "Raw command output" panel.
3. **Test connection** to verify credentials before collecting.
4. **Collect now** to SSH in, run the commands, and append a snapshot to
   `data/usage_data.yaml`.
5. Select the host in the **Dashboard** section to see a process timeline
   (Gantt-style, colored by user), stat cards, a sortable process table, and
   raw command output.

### Headless / scheduled collection

To collect continuously without the browser open (e.g. via cron or Task
Scheduler):

```bash
python -m backend.collector --all
# or
python -m backend.collector --host-id <id>
```

This appends to the same `data/usage_data.yaml` the web UI reads from.

## Security note

`data/hosts.yaml` may contain SSH passwords or point at identity files, and
`data/usage_data.yaml` contains process/user activity from your customers'
systems. Both are local files, not committed anywhere by default — treat them
as sensitive. Prefer identity-file auth over password auth where possible.
