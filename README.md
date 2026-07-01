# S7 Sync Server

Share and synchronize data between multiple Siemens S7-1200 PLCs through a lightweight Node.js intermediary.

Instead of the traditional Siemens PUT/GET mesh where every PLC talks directly to every other PLC, this server acts as a central hub. It reads a shared data block from each PLC and writes the combined dataset back into a synchronization data block on every PLC, so each PLC has a real-time snapshot of all the others. A web GUI, an HTTPS JSON API and optional MQTT integration are included.

## Features

- Multi-PLC data sharing and synchronization through one intermediary.
- HTTPS JSON API for monitoring combined data, per-PLC data and read/write counters.
- Single JSON configuration file (JSONC, so comments are allowed).
- Automatic calculation of synchronization offsets.
- Web GUI for visualization, configuration and control.
- **Field Manager**: add or remove shared fields across all PLCs from one place. It recomputes every offset and generates importable TIA `.db` external-source files, so the three edit sites stay consistent.
- **Pause/Resume sync**: suspend only the cross-PLC sync writes during a DB layout change, without stopping the process.
- Rotating log files, Basic authentication (bcrypt), and a built-in manual.
- Optional MQTT publish and subscribe.

## Requirements

- Node.js 18+ (v12+ works, 18+ recommended).
- Siemens S7-1200 PLCs with PUT/GET communication enabled.
- The relevant Data Blocks must have **optimized block access disabled** (absolute addressing).
- A process manager such as PM2 (recommended).

## Installation

```bash
git clone https://github.com/nrbrt/s7_sync_server.git
cd s7_sync_server
npm install

# create your own config and credentials from the examples
cp config.example.json config.json
cp credentials.example.json credentials.json

# generate a bcrypt hash for the admin password, then paste it into credentials.json
node createhash.js
```

Provide TLS material in `certs/` (`cert.pem` + `key.pem`); a self-signed pair is fine on a trusted network. Then start it:

```bash
npm start                        # runs: node sws5.js
# or under a process manager:
pm2 start sws5.js --name plc-sync
```

## Configuration

Everything lives in `config.json`. Start from the fully commented `config.example.json`. Because the loader parses JSONC, comments are allowed in your live `config.json` too. Key sections:

- `httpPort`, `operationInterval` (ms between update cycles), `maxReconnectAttempts`, `reconnectInterval`.
- `apiConfig`: base URL and endpoint paths the web GUI uses to reach the server.
- `plcs[]`: one entry per PLC, with `name`, `ip`, `rack`, `slot`, `dbNumber` (the PLC's shared block), `syncDbNumber` (the combined sync DB), and `variables`.
  - Variable descriptors: `BOOL` uses `{ "type": "BOOL", "byte": N, "bit": N }`; `INT` and `REAL` use `{ "type": "INT", "offset": N }` (`INT` is 2 bytes, `REAL` is 4 bytes).
- `mqttConfigs[]`: optional brokers, each with `brokerUrl`, an optional `subscribeTopics` map (`{ dataType, syncVariable }` per topic), and a `publishTopic`. Leave the array empty if you do not use MQTT.

`config.json` is the single source of truth for field names.

## HTTP API

The server runs over HTTPS with Basic authentication, so every call uses `https://` and `-u user:password`.

| Method and path | Purpose |
| --- | --- |
| `GET /data` | Heartbeat, combined PLC data and counters (JSON). |
| `GET /status` | Server and per-PLC status. |
| `GET /plc/<name>` | Latest data from one PLC. |
| `POST /plc/<name>` | Write variables to a PLC (JSON body `{ "var": value }`). |
| `GET /gui`, `/setup`, `/fields`, `/manual` | Web pages. |
| `POST /config` | Replace the configuration (backs up to `config.json.bak`, takes effect on restart). |
| `POST /fields/preview` | Compute the new config and `.db` artifacts for an add/remove, without writing. |
| `POST /sync/pause`, `/sync/resume`, `GET /sync/status` | Pause or resume only the cross-PLC sync writes. |
| `POST /update-credentials` | Change the login username and password. |
| `POST /restart` | Exit gracefully so the process manager restarts it. |
| `GET /logs`, `GET /logs/<file>` | List logs, or read the last 100 lines of one. |
| `GET /logout` | Force a credentials re-prompt. |

Examples:

```bash
curl -k -u admin:yourpassword https://your-server:3011/data

curl -k -X POST https://your-server:3011/plc/PLC_1 \
     -u admin:yourpassword -H "Content-Type: application/json" \
     -d '{"machine_running": true, "current_speed": 1200}'
```

## How synchronization works

Each cycle the server reads every PLC's shared block and writes the combined dataset into the sync DB (the DB200 convention) on every PLC, plus a heartbeat the PLCs watch to confirm the data is fresh. Per-PLC `reachable` and `alive` status is tracked.

**The server attaches no meaning to field names or values.** It simply transports each PLC's shared bytes to every other PLC, so you are free to structure the shared data however you like.

### A request / ack / state handshake (one convention)

As one example of coordinating over the shared data, fields can use three suffixes. Each field is written by the PLC in whose `share_this_data` it lives and read by the others through the sync DB:

- `_req` / `_request`: the desired state or value, written by the **requesting** PLC. It may carry a setpoint (for example `pump_a_speed_request` as an INT) or be a simple on/off BOOL.
- `_ack` (BOOL): also written by the **requesting** PLC. `false` means a request is open or in progress; `true` means the executor has reached the requested state.
- `_state` / `_stat`: the actual current state or feedback, written by the **executing** PLC.

Flow: the requester writes `_req` and sets `_ack = false`, which opens the request. The executor drives its output toward `_req` and reflects it in `_state`. The requester sets `_ack = true` once `_state` matches `_req`, which closes the handshake. It is level-based and tolerant of the cyclic sync latency: while `_ack` stays `false` the executor keeps driving toward `_req`. Multiple requesters each use their own `_req`/`_ack` pair, so independent requests run as parallel handshakes.

Example: to start a pump on `PLC_B`, `PLC_A` sets `pump_a_req = true` and `pump_a_ack = false`. `PLC_B` sees the open request, runs the pump and publishes `pump_a_state = true`. `PLC_A` sees the state match its request and sets `pump_a_ack = true`.

## Field Manager

A shared field lives in three places that must stay consistent: the source PLC's `share_this_data` DB, the combined sync DB on **every** PLC, and the offsets in `config.json`. The Field Manager (`/fields`) automates this. Pick a PLC, add (one or several) or remove a field, and it recomputes all offsets and generates the importable TIA `.db` external-source files (`share_this_data.<PLC>.db` and `synced_data.db`) plus the updated `config.json`.

Each preview reports whether the change is **hot-safe**. Only appending a field to the *last* PLC in config order is truly hot-safe (nothing shifts in the sync DB). Adding to any other PLC shifts every downstream PLC's offset, and removing repacks the block; both relocate live data, so they need a coordinated rollout.

Recommended workflow for a layout change:

1. In the Field Manager, make the change and click **Replace config.json** (the running server keeps syncing on its old in-memory config, and the old file is saved as `config.json.bak`). Download the generated `.db` files.
2. On the Setup page, click **Pause Sync** right before touching the PLCs, to keep the disruption window short.
3. In TIA, import the new `share_this_data.<PLC>.db` into each edited PLC and the new `synced_data.db` into *all* PLCs.
4. **Restart** the server. The new `config.json` loads and, because a restart clears the pause flag, syncing resumes automatically on the new consistent layout.

## MQTT integration

For each configured broker the server subscribes to the defined topics (merging incoming values into the shared dataset according to their `dataType`) and, each cycle, publishes a JSON payload containing the server heartbeat, the combined PLC data, and any MQTT-sourced data to the configured `publishTopic`.

## Logging

The server writes daily-rotated info and error logs (`plc-app-*.log`, `plc-errors-*.log`). Browse them through `/logs` or the Setup page.

## Troubleshooting

- **Connection issues:** verify the PLC IP, rack, slot and PUT/GET settings, and make sure the network allows TCP port 102.
- **Data not syncing:** confirm the DBs are not optimized and that absolute addressing is configured.
- **Heartbeat stagnant:** confirm the PLC logic is running and that the correct DB address is read.
- **Reachable but not alive:** if the server connects but the PLC appears unresponsive, verify the PLC's heartbeat-updating logic.

## License

See [LICENSE](LICENSE).
