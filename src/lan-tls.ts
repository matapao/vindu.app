// Both Wi-Fi listeners use the same identity. The device must trust the issuer of this certificate.
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createSecureContext, type SecureContextOptions } from 'node:tls';

export function readLanTls(userData: string, name = `${os.hostname().replace(/\.local$/i, '')}.local`) {
  const hostname = name.toLowerCase();
  if (hostname.length > 253 || !hostname.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
    || isIP(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Set VINDU_LAN_NAME to the DNS name devices use for this computer.');
  }
  try {
    const cert = readFileSync(path.join(userData, 'lan-cert.pem'));
    const key = readFileSync(path.join(userData, 'lan-key.pem'));
    const leaf = new X509Certificate(cert);
    const now = Date.now();
    if (!leaf.checkHost(hostname, { subject: 'never' }) || now < Date.parse(leaf.validFrom) || now >= Date.parse(leaf.validTo)) throw new Error();
    const options: SecureContextOptions = { cert, key, minVersion: 'TLSv1.2' };
    createSecureContext(options); // also checks that the private key matches the certificate
    return { hostname, options, leaf };
  } catch {
    throw new Error(`Wi-Fi access needs a current TLS certificate for ${hostname} in lan-cert.pem and its matching key in lan-key.pem in Vindu’s data folder. Devices must trust its issuer.`);
  }
}
