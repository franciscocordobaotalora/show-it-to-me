import os
import json
import threading
import time
from datetime import datetime, timezone

_lock = threading.Lock()
_DEFAULT_PATH = '/data/project/logs/events.jsonl'
_MAX_BYTES = 20 * 1024 * 1024
_KEEP = 5

def _get_path():
    return os.getenv('SIT_EVENT_LOG', _DEFAULT_PATH)

def _ensure_dir(path):
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        try:
            os.makedirs(d, exist_ok=True)
        except Exception:
            pass

def _rotate(path):
    if not os.path.isfile(path):
        return
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    if size < _MAX_BYTES:
        return
    # Shift old files: .4 -> .5, ... .1 -> .2, then current -> .1
    for i in range(_KEEP - 1, 0, -1):
        src = f"{path}.{i}"
        dst = f"{path}.{i+1}"
        if os.path.exists(src):
            try:
                os.replace(src, dst)
            except OSError:
                pass
    # Remove .KEEP+1 if exists to keep only KEEP files
    overflow = f"{path}.{_KEEP+1}"
    if os.path.exists(overflow):
        try:
            os.remove(overflow)
        except OSError:
            pass
    try:
        os.replace(path, f"{path}.1")
    except OSError:
        pass

# Keys that are allowed even though they contain "image" substring
_ALLOWED_IMAGE_KEYS = {'image_size', 'image_sha_prefix'}

def _is_secret_key(k_lower):
    # Check common secret substrings
    secret_subs = ('apikey', 'api_key', 'api-key', 'secret', 'token', 'cookie', 'authorization', 'password')
    for s in secret_subs:
        if s in k_lower:
            return True
    # Generic 'auth' and 'key' but avoid false positives on allowed keys
    # Only flag if key is short and clearly credential-like
    if k_lower in ('key', 'auth', 'auth_header', 'x-api-key'):
        return True
    # If key contains 'key' and is credential-like (e.g., muse_api_key, api_key)
    # but allow image_size etc which we already handled
    if 'key' in k_lower and any(x in k_lower for x in ('api', 'muse', 'sam', 'hf', 'openai')):
        return True
    return False

def log_event(event, requestId=None, frameId=None, level='info', **fields):
    try:
        path = _get_path()
        _ensure_dir(path)
        with _lock:
            _rotate(path)
            ts = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            obj = {
                'ts': ts,
                'event': event,
                'requestId': requestId,
                'frameId': frameId,
                'level': level,
            }
            safe_fields = {}
            for k, v in fields.items():
                lk = k.lower()
                # Allow explicit image metadata
                if k in _ALLOWED_IMAGE_KEYS:
                    safe_fields[k] = v
                    continue
                # Never log raw image data or base64 payloads
                if 'base64' in lk:
                    continue
                if lk in ('image', 'image_data', 'data', 'payload', 'img', 'photo'):
                    # If value is data URL, skip; otherwise skip key anyway
                    continue
                if lk == 'image' or lk.startswith('image_') and lk not in _ALLOWED_IMAGE_KEYS:
                    # Block any other image_* not in allowlist
                    continue
                if _is_secret_key(lk):
                    continue
                # Also filter values that look like data URLs containing base64
                if isinstance(v, str) and v.startswith('data:image') and 'base64' in v:
                    continue
                if isinstance(v, str) and len(v) > 2000 and 'base64,' in v:
                    continue
                safe_fields[k] = v
            obj.update(safe_fields)
            line = json.dumps(obj, separators=(',', ':'))
            with open(path, 'a', encoding='utf-8') as f:
                f.write(line + '\n')
                f.flush()
                try:
                    os.fsync(f.fileno())
                except Exception:
                    pass
    except Exception:
        # logging failure must never break request
        pass
