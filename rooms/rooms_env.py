"""Load the shared config file into os.environ before anything reads it. Real environment variables win.

File: $AGENT_ROOMS_CONFIG, else ${XDG_CONFIG_HOME:-~/.config}/agent-rooms/config.env (see config.example.env).
Format: KEY=VALUE lines, # comments, optional quotes; a leading ~ and $HOME are expanded.
"""
import os
import re

LINE = re.compile(r'^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$')


def config_path():
    return os.environ.get('AGENT_ROOMS_CONFIG') or os.path.join(
        os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'), 'agent-rooms', 'config.env')


def load():
    try:
        with open(config_path(), encoding='utf-8') as f:
            lines = f.read().splitlines()
    except OSError:
        return
    home = os.path.expanduser('~')
    for raw in lines:
        m = LINE.match(raw)
        if not m or m.group(1) in os.environ:
            continue
        v = m.group(2).strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
            v = v[1:-1]
        if v.startswith('~'):
            v = home + v[1:]
        os.environ[m.group(1)] = v.replace('$HOME', home)


load()
