#!/usr/bin/env python3
"""Add only the /oneword/ location; leave existing applications intact."""
from pathlib import Path
import subprocess

path = Path('/etc/nginx/sites-available/beiyexing')
original = path.read_text()
if 'location /oneword/' in original:
    raise SystemExit(0)
anchor = '    location /marathon/ {'
if anchor not in original:
    anchor = '    location / {\n        proxy_pass http://127.0.0.1:3780;'
if anchor not in original:
    raise SystemExit('Expected nginx location not found; no changes made.')
block = '''    # OneWord: isolated service, port 3795
    location = /oneword { return 308 /oneword/; }
    location /oneword/ {
        proxy_pass http://127.0.0.1:3795;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

'''
backup = path.with_name(path.name + '.before-oneword')
if not backup.exists():
    backup.write_text(original)
path.write_text(original.replace(anchor, block + anchor, 1))
if subprocess.run(['nginx', '-t'], capture_output=True).returncode:
    path.write_text(original)
    raise SystemExit('nginx validation failed; original config restored.')
print('OneWord nginx location ready.')
