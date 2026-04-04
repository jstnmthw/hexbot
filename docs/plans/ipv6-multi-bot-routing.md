# Plan: IPv6 Multi-Bot Routing

## Summary

Route each IRC bot container through a unique public IPv6 address using the IONOS VPS's free IPv6 allocation. Each bot gets a static private IPv6 on the Docker `irc-bots` bridge, and nftables SNAT maps each to a distinct public IPv6 on the VPS. This allows running multiple bots on the same IRC network without triggering per-IP connection limits.

## Feasibility

- **Alignment:** Pure infrastructure — minimal hexbot code changes. The bot just needs an optional `bind_address` config field (irc-framework already supports `outgoing_addr`).
- **Dependencies:** Working WireGuard tunnel (wg1) — already in place.
- **Blockers:** None. IONOS must have IPv6 assigned to the VPS (verify in panel).
- **Complexity:** M (a day) — mostly infrastructure config, small code change.
- **Risk areas:**
  - Some IRC networks resolve to IPv4-only hostnames; bot must be told to use IPv6.
  - DCC CHAT is IPv4-only in the current design — unaffected but won't work over IPv6.
  - Happy Eyeballs must remain disabled (already done) or IPv4/IPv6 racing will break routing again.

## Phases

### Phase 1: VPS — Assign IPv6 addresses

**Goal:** Have 3–5 usable public IPv6 addresses on the IONOS VPS.

- [ ] In the IONOS panel, assign additional IPv6 addresses (or confirm a /64 is already routed)
- [ ] Configure the VPS network interface with the addresses:
  ```bash
  # /etc/network/interfaces or netplan — add each IPv6
  ip -6 addr add 2001:db8::1/128 dev eth0
  ip -6 addr add 2001:db8::2/128 dev eth0
  ip -6 addr add 2001:db8::3/128 dev eth0
  ```
- [ ] Verify: `ping6 -c1 2001:db8::1` from an external host

### Phase 2: WireGuard — Add IPv6 to the tunnel

**Goal:** IPv6 traffic flows between the home server and VPS through wg1.

- [ ] **VPS side** (`/etc/wireguard/wg1.conf`):

  ```ini
  [Interface]
  Address = 10.200.0.1/24, fd00:wg1::1/64
  # ... existing config ...

  [Peer]
  AllowedIPs = 10.200.0.2/32, fd00:wg1::0/64
  ```

- [ ] **Home server side** (`/etc/wireguard/wg1.conf`):

  ```ini
  [Interface]
  Address = 10.200.0.2/24, fd00:wg1::2/64

  [Peer]
  AllowedIPs = 0.0.0.0/0, ::/0
  ```

- [ ] Restart WireGuard on both ends: `wg-quick down wg1 && wg-quick up wg1`
- [ ] Verify: `ping6 -c1 fd00:wg1::1` from home server

### Phase 3: VPS — IPv6 forwarding and NAT

**Goal:** The VPS forwards IPv6 from the tunnel to the public addresses.

- [ ] Enable IPv6 forwarding:
  ```bash
  sysctl -w net.ipv6.conf.all.forwarding=1
  # Make permanent in /etc/sysctl.d/
  ```
- [ ] Add ip6tables or nftables rules on the VPS to SNAT tunnel traffic:
  ```nft
  table ip6 nat_wg {
    chain postrouting {
      type nat hook postrouting priority srcnat; policy accept;
      iifname "wg1" oifname "eth0" ip6 saddr fd00:wg1::10 snat to 2001:db8::1
      iifname "wg1" oifname "eth0" ip6 saddr fd00:wg1::11 snat to 2001:db8::2
      iifname "wg1" oifname "eth0" ip6 saddr fd00:wg1::12 snat to 2001:db8::3
    }
  }
  ```
- [ ] Verify: from home server, `curl -6 --interface fd00:wg1::10 https://ifconfig.me` shows the correct public IPv6

### Phase 4: Docker — IPv6 on the irc-bots network

**Goal:** Each bot container gets a static private IPv6 that routes through wg1.

- [ ] Enable IPv6 in Docker daemon (`/etc/docker/daemon.json`):
  ```json
  {
    "ipv6": true,
    "fixed-cidr-v6": "fd00:docker::/64"
  }
  ```
- [ ] Recreate the `irc-bots` network with IPv6 and proper MTU:
  ```bash
  docker network rm irc-bots
  docker network create --driver bridge \
    --subnet 172.30.0.0/16 \
    --ipv6 --subnet fd00:irc::/64 \
    -o com.docker.network.driver.mtu=1380 \
    irc-bots
  ```
- [ ] Assign static IPv6 per bot in `docker-compose.override.yml`:

  ```yaml
  networks:
    irc-bots:
      external: true

  services:
    hexbot:
      networks:
        irc-bots:
          ipv4_address: 172.30.0.10
          ipv6_address: fd00:irc::10
  ```

- [ ] Verify: `docker compose exec hexbot sh -c 'ip -6 addr show eth0'` shows the assigned IPv6

### Phase 5: Home server — nftables IPv6 routing

**Goal:** IPv6 traffic from each bot container is marked and routed through wg1, then SNAT'd to the correct tunnel address.

- [ ] Add IPv6 policy routing table:
  ```bash
  # /etc/iproute2/rt_tables — add if not present:
  200 wg1_v6
  ```
  ```bash
  ip -6 route add default dev wg1 table 200
  ip -6 rule add fwmark 0x2 lookup 200
  ```
- [ ] Extend `/etc/nftables.conf` — add IPv6 mangle and SNAT:

  ```nft
  define DOCKER_IRC_V6 = fd00:irc::/64

  # In table inet mangle, chain prerouting:
  ip6 saddr $DOCKER_IRC_V6 meta mark set 0x2

  # In table inet mangle, chain output:
  ip6 saddr $DOCKER_IRC_V6 meta mark set 0x2

  # New table for IPv6 SNAT (or extend nat_wg):
  table ip6 nat_wg {
    chain postrouting {
      type nat hook postrouting priority srcnat; policy accept;
      oifname "wg1" ip6 saddr fd00:irc::10 snat to fd00:wg1::10
      oifname "wg1" ip6 saddr fd00:irc::11 snat to fd00:wg1::11
      oifname "wg1" ip6 saddr fd00:irc::12 snat to fd00:wg1::12
    }
  }
  ```

- [ ] Extend `raw_wg` to accept IPv6 from wg1 (bypass Docker raw rules):
  ```nft
  # Already covered by existing: iifname $WG_IRC_IF accept
  ```
- [ ] Verify: `docker compose exec hexbot sh -c "curl -6 https://ifconfig.me"` shows the expected public IPv6

### Phase 6: Hexbot — optional `bind_address` config

**Goal:** Let each bot bind to a specific local address so irc-framework uses the right address family.

- [ ] Add `bind_address` to `IrcConfig` in `src/types.ts`:
  ```typescript
  /** Local address to bind outgoing IRC connections to.
   *  Set to the container's IPv6 address to force IPv6 connectivity. */
  bind_address?: string;
  ```
- [ ] Pass it through in `src/bot.ts` `buildClientOptions()`:
  ```typescript
  if (cfg.bind_address) {
    options.outgoing_addr = cfg.bind_address;
  }
  ```
  irc-framework already handles `outgoing_addr` — it sets `localAddress` and infers the address family from the IP format.
- [ ] Update `config/bot.example.json` with the new field (commented/documented)
- [ ] Verify: bot connects via IPv6, `whois` on IRC shows the public IPv6 address

## Config changes

**`config/bot.json`** — new optional field per bot:

```json
{
  "irc": {
    "host": "irc.rizon.net",
    "port": 6697,
    "tls": true,
    "bind_address": "fd00:irc::10"
  }
}
```

## Database changes

None.

## Test plan

- Unit test: `buildClientOptions()` passes `outgoing_addr` when `bind_address` is set, omits it when not set
- Manual: bot connects, `whois HEX` on IRC shows the assigned public IPv6
- Manual: second bot on `fd00:irc::11` shows a different public IPv6
- Manual: DCC CHAT still works over IPv4 (regression check)

## Open questions

1. **How many IPv6 addresses does IONOS provide?** Need to confirm allocation size (single addresses vs /64 block).
2. **Which IRC networks need IPv6?** Just Rizon, or others too? Some networks may not have IPv6 support.
3. **DNS resolution:** `irc.rizon.net` resolves to IPv4 and IPv6 — with `autoSelectFamily: false` and `bind_address` set to an IPv6, irc-framework will force family 6 and resolve AAAA records. Confirmed this works via irc-framework's `getAddressFamily()`.
4. **VPS nftables vs ip6tables:** Does the IONOS VPS currently use nftables or iptables? The plan assumes nftables — adjust if needed.
