import os, json, urllib.request

MUSE_API_BASE = os.getenv('MUSE_API_BASE','')
MUSE_API_KEY = os.getenv('MUSE_API_KEY','')
MODEL = 'muse-glimmer-hackathon'

def _post_chat(messages, timeout=120):
    if not MUSE_API_BASE or not MUSE_API_KEY:
        raise RuntimeError('Muse API not configured')
    url = MUSE_API_BASE.rstrip('/')
    if not url.endswith('/v1'):
        url = url + '/v1'
    url = url + '/chat/completions'
    payload = {
        'model': MODEL,
        'messages': messages,
        'chat_template_kwargs': {'reasoning_strength':'low'}
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method='POST')
    req.add_header('Content-Type','application/json')
    req.add_header('Authorization', f'Bearer {MUSE_API_KEY}')
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
    return json.loads(body)

class GlimmerError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)

def _extract_content(resp):
    msg = resp['choices'][0]['message']
    content = msg.get('content','')
    if content.strip().startswith('```'):
        content = content.strip()[3:]
        if content.startswith('json'):
            content = content[4:]
        content = content.strip().rstrip('```').strip()
    return content

def pass1(image_data_url, question, reference_text):
    messages = [
        {'role':'system','content':'Return strict JSON with view, needs_view, targets[{id,part,sam_prompt,box_1000}], reply_hint.'},
        {'role':'user','content': f'Reference:\n{reference_text}\nQuestion: {question}\nImage URL: {image_data_url}'},
    ]
    try:
        resp = _post_chat(messages, timeout=120)
        content = _extract_content(resp)
        return json.loads(content)
    except json.JSONDecodeError:
        # retry
        messages[0]['content'] = 'Return ONLY valid JSON, no markdown, no reasoning.'
        try:
            resp = _post_chat(messages, timeout=120)
            content = _extract_content(resp)
            return json.loads(content)
        except Exception:
            raise GlimmerError('glimmer_bad_json')
    except TimeoutError:
        raise GlimmerError('glimmer_timeout')
    except Exception:
        raise GlimmerError('glimmer_unreachable')

def pass2(view, targets, question):
    messages = [{'role':'system','content':'Explain briefly using found regions.'},{'role':'user','content': f'View:{view}\nTargets:{targets}\nQuestion:{question}'}]
    resp = _post_chat(messages, timeout=120)
    return _extract_content(resp)
