# STAR Network Collector

An on-premise Docker Compose stack that collects network telemetry and pushes
it to the STAR Alert System Supabase database.

| Service | What it collects |
|---|---|
| **goflow2** | NetFlow v5/v9/IPFIX records from pfSense |
| **goflow2_parser** | Parses goflow2 JSON and writes to `network_flows` |
| **telegraf** | UniFi port stats → `switch_port_metrics`; ICMP latency → `latency_metrics` |
| **fping_collector** | Per-device ICMP latency → `latency_metrics` |
| **health_reporter** | Heartbeat + source-liveness check → `collector_heartbeat` |

---

## Prerequisites

- Docker Desktop (Windows/Mac) or Docker Engine + Docker Compose plugin (Linux)
- The machine must be **inside the office network** (or connected via VPN)
- Supabase project with the network schema applied (migration 0002)
- pfSense firewall (for NetFlow)
- UniFi Controller (for switch/AP stats)

---

## Quick Start

```bash
# 1. Clone the repo (or copy the collector/ directory to the target machine)
cd collector

# 2. Create your .env from the template and fill in all values
cp .env.example .env
nano .env   # or any editor

# 3. Start all services
docker compose up -d
```

Check that everything is running:

```bash
docker compose ps
docker compose logs -f
```

---

## pfSense NetFlow Configuration

pfSense exports flow records via the **softflowd** package. goflow2 listens on
UDP port 9995 (or whatever you set `NETFLOW_PORT` to).

1. In pfSense: **System → Package Manager → Available Packages**
   - Search for `softflowd` and click **+ Install**

2. Go to **Services → softflowd**

3. Set the following fields:
   | Field | Value |
   |---|---|
   | Interface | WAN (and/or LAN if you want internal traffic) |
   | Host | IP address of the machine running this collector |
   | Port | `9995` (must match `NETFLOW_PORT` in your `.env`) |
   | Max Flows | `8192` |
   | NetFlow Version | `9` |

4. Click **Save**, then **Start**

5. Verify flows are arriving:
   ```bash
   docker compose logs goflow2 -f
   # You should see "Listening on UDP :9995" and flow counts increasing
   ```

---

## UniFi Read-Only Account

Telegraf needs credentials to poll the UniFi Controller API. Create a dedicated
read-only account so you do not expose your admin password.

1. Log in to your UniFi Controller (default: `https://192.168.1.1:8443`)

2. Go to **Settings → Admins** (or **Settings → Administrators** in newer UI)

3. Click **+ Create New Admin**

4. Fill in:
   | Field | Value |
   |---|---|
   | Name | `star-monitor` (or any name you prefer) |
   | Email | any valid email |
   | Password | a strong password — note it for `UNIFI_PASS` |
   | Role | **Read Only** |

5. Click **Create**

6. Set `UNIFI_USER=star-monitor` and `UNIFI_PASS=<password>` in your `.env`

---

## Finding Your ISP Gateway IP

The ISP gateway is the first hop outside your pfSense firewall. Setting
`ISP_GATEWAY_IP` lets fping_collector categorise it as `wan` and gives you
a latency baseline to your ISP's equipment.

**From Windows:**
```cmd
tracert 8.8.8.8
```

**From Linux/macOS:**
```bash
traceroute 8.8.8.8
```

The **second** hop in the output (after your pfSense WAN IP) is typically your
ISP gateway. Copy that IP into `ISP_GATEWAY_IP` in your `.env`.

If the hop shows `* * *` (ICMP blocked by ISP), leave `ISP_GATEWAY_IP` blank.

---

## Moving the Collector to Another Machine

The entire configuration is in `.env`. No data is stored locally — everything
goes straight to Supabase.

```bash
# On the new machine:
cd collector
cp /path/to/old/.env .env
docker compose up -d
```

The `collector_heartbeat` row will update automatically; the old machine's
row remains but its `last_seen` will stop updating.

---

## Troubleshooting

### goflow2 receives no flows

- Confirm pfSense softflowd is running: **Services → softflowd → Status**
- Check the collector machine's IP matches the **Host** field in softflowd
- Ensure UDP port 9995 is not blocked by a host-based firewall on the collector machine:
  ```bash
  # Linux: allow incoming UDP 9995
  sudo ufw allow 9995/udp
  ```
- Check goflow2 logs:
  ```bash
  docker compose logs goflow2
  ```

### Telegraf fails to connect to UniFi

- Verify `UNIFI_URL` includes `https://` and the IP is reachable from the collector machine
- UniFi uses a self-signed certificate — ensure `UNIFI_VERIFY_SSL=false` in your `.env`
- Confirm the `star-monitor` account exists and the password is correct:
  ```bash
  docker compose logs telegraf
  ```

### fping_collector exits immediately

- The container requires the `NET_RAW` capability to send ICMP packets
  (already set in `docker-compose.yml`). If Docker Desktop restricts capabilities,
  try running with `--privileged` temporarily to diagnose.

### Supabase writes fail (401 Unauthorised)

- Confirm you are using the **service_role** key, not the **anon** key
- The service_role key is found in: **Supabase dashboard → Project Settings → API → service_role**

### health_reporter shows sources as SILENT

- A source is considered silent if it has not written a row within 5 minutes
- This is normal for the first few minutes after startup while services initialise
- If a source remains silent, check its individual logs:
  ```bash
  docker compose logs goflow2_parser
  docker compose logs fping_collector
  docker compose logs telegraf
  ```
