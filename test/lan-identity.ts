// Issue a short-lived certificate only for these tests. A client explicitly trusts it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const wifiName = 'testbox.local';

export function makeLanIdentity(dir: string) {
  const config = path.join(dir, 'openssl.cnf'), cert = path.join(dir, 'lan-cert.pem');
  fs.writeFileSync(config, `[req]
prompt = no
distinguished_name = name
x509_extensions = extensions
[name]
CN = ${wifiName}
[extensions]
subjectAltName = DNS:${wifiName}, IP:::1
basicConstraints = critical,CA:FALSE
extendedKeyUsage = serverAuth
`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config,
    '-keyout', path.join(dir, 'lan-key.pem'), '-out', cert], { stdio: 'pipe' });
  return { ca: fs.readFileSync(cert), servername: wifiName };
}
