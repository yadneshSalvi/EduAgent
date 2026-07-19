"""EduAgent demo VPS on Hetzner Cloud.

Creates: an SSH keypair, a firewall (inbound 22/80/443 + ICMP only; outbound
unrestricted), and one Ubuntu 24.04 server whose first boot installs Docker
(with the compose plugin) and git via cloud-init. The application itself is
deployed per docs/DEPLOY_RUNBOOK.md (docker compose + Caddy auto-HTTPS) over
SSH — this program owns only the infrastructure.

Config:
  hcloud:token  (secret)  Hetzner Cloud API token
  serverType    (default cx32)  4 vCPU x86 / 8 GB — sized for the 5–10-user demo
  location      (default hel1)
"""

import pulumi
import pulumi_hcloud as hcloud
import pulumi_tls as tls

config = pulumi.Config()
server_type = config.get("serverType") or "cx32"
location = config.get("location") or "hel1"

ssh = tls.PrivateKey("eduagent-ssh", algorithm="ED25519")

ssh_key = hcloud.SshKey("eduagent-key", public_key=ssh.public_key_openssh)

ANYWHERE = ["0.0.0.0/0", "::/0"]
firewall = hcloud.Firewall(
    "eduagent-fw",
    rules=[
        hcloud.FirewallRuleArgs(direction="in", protocol="tcp", port="22", source_ips=ANYWHERE),
        hcloud.FirewallRuleArgs(direction="in", protocol="tcp", port="80", source_ips=ANYWHERE),
        hcloud.FirewallRuleArgs(direction="in", protocol="tcp", port="443", source_ips=ANYWHERE),
        hcloud.FirewallRuleArgs(direction="in", protocol="icmp", source_ips=ANYWHERE),
    ],
)

CLOUD_INIT = """#cloud-config
package_update: true
packages:
  - git
  - curl
  - ca-certificates
runcmd:
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable --now docker
"""

server = hcloud.Server(
    "eduagent",
    server_type=server_type,
    image="ubuntu-24.04",
    location=location,
    ssh_keys=[ssh_key.id],
    firewall_ids=[firewall.id.apply(int)],
    user_data=CLOUD_INIT,
)

pulumi.export("ipv4", server.ipv4_address)
pulumi.export("serverType", server_type)
pulumi.export("location", location)
pulumi.export("sshPrivateKey", pulumi.Output.secret(ssh.private_key_openssh))
