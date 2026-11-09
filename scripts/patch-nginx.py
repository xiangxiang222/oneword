#!/usr/bin/env python3
"""Add the isolated location to both HTTP and HTTPS proxy server blocks."""
from pathlib import Path
import subprocess
import re

BLOCK = '''    # OneWord: isolated service, port 3795
    location = /oneword { return 308 /oneword/; }
    location /oneword/ {
        client_max_body_size 6m;
        proxy_pass http://127.0.0.1:3795;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

'''

def patch_config(original):
    anchor = '    location /marathon/ {'
    if anchor not in original:
        anchor = '    location / {\n        proxy_pass http://127.0.0.1:3780;'
    if anchor not in original:
        raise ValueError('Expected nginx locations not found; no changes made.')
    existing = original.count('location /oneword/')
    if existing:
        if existing != original.count(anchor):
            raise ValueError('Partial OneWord nginx configuration found; no changes made.')
        # Earlier read-only releases used nginx's inherited upload limit. Only
        # update our own proxy location so full progress snapshots can sync.
        def upgrade(match):
            body = match.group(2)
            if 'proxy_pass http://127.0.0.1:3795;' not in body:
                raise ValueError('Unknown OneWord upstream; no changes made.')
            directive = '        client_max_body_size 6m;\n'
            if re.search(r'^\s*client_max_body_size\s+', body, re.M):
                body = re.sub(r'^\s*client_max_body_size\s+[^;]+;\s*\n', directive, body, flags=re.M)
            else:
                body = directive + body
            return match.group(1) + body + match.group(3)
        updated, count = re.subn(r'(    location /oneword/ \{\n)(.*?)(    \}\n)', upgrade, original, flags=re.S)
        if count != existing:
            raise ValueError('Unknown OneWord location layout; no changes made.')
        return updated
    # The reference host has separate HTTP and HTTPS server blocks. Each needs
    # the location; inserting only once leaves the public HTTPS URL unreachable.
    return original.replace(anchor, BLOCK + anchor)

def main():
    path = Path('/etc/nginx/sites-available/beiyexing')
    original = path.read_text()
    try:
        updated = patch_config(original)
    except ValueError as error:
        raise SystemExit(str(error))
    if updated == original:
        return
    backup = path.with_name(path.name + '.before-oneword')
    if not backup.exists():
        backup.write_text(original)
    path.write_text(updated)
    if subprocess.run(['nginx', '-t'], capture_output=True).returncode:
        path.write_text(original)
        raise SystemExit('nginx validation failed; original config restored.')
    print('OneWord HTTP and HTTPS nginx locations ready.')

if __name__ == '__main__':
    main()
