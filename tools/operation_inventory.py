#!/usr/bin/env python3
"""Check docs/OPERATIONS.md against a kinopio-client checkout.

Usage: python3 tools/operation_inventory.py /path/to/kinopio-client

Finds every operation name passed to apiStore.addToQueue({ name: '...' })
and fails if the client sends a name the doc's table doesn't cover, or the
doc lists a name the client no longer sends.
"""
import os
import re
import sys

DOC = os.path.join(os.path.dirname(__file__), '..', 'docs', 'OPERATIONS.md')


def client_ops(client_dir):
    names = set()
    for root, _, files in os.walk(os.path.join(client_dir, 'src')):
        for f in files:
            if not f.endswith(('.js', '.vue')):
                continue
            txt = open(os.path.join(root, f), encoding='utf-8').read()
            for m in re.finditer(r'addToQueue\(\s*\{\s*name:\s*\'(\w+)\'', txt):
                names.add(m.group(1))
            # calls whose object literal spans lines: addToQueue({\n  name: '...'
            for m in re.finditer(r'addToQueue\(\s*\{\s*\n\s*name:\s*\'(\w+)\'', txt):
                names.add(m.group(1))
    return names


def doc_ops():
    names, in_table = set(), False
    for line in open(DOC, encoding='utf-8'):
        if line.startswith('## '):
            in_table = line.strip() == '## Operations'
        m = re.match(r'\| `(\w+)` \|', line)
        if in_table and m:
            names.add(m.group(1))
    return names


def main():
    client, doc = client_ops(sys.argv[1]), doc_ops()
    missing, stale = sorted(client - doc), sorted(doc - client)
    print(f'client sends {len(client)} operation names; doc covers {len(doc)}')
    if missing:
        print('NOT IN DOC:', ', '.join(missing))
    if stale:
        print('IN DOC BUT NOT SENT:', ', '.join(stale))
    sys.exit(1 if missing or stale else 0)


if __name__ == '__main__':
    main()
