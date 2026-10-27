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

def _extract_content(resp):
    msg = resp['choices'][0]['message']
    content = msg.get('content','')
    # strip reasoning markers if present
    if 'reasoning_content' in msg:
        # keep content only
        pass
    # strip code fences
    if content.strip().startswith('```'):
        content = content.strip()[3:]
        if content.startswith('json'):
            content = content[4:]
        content = content.strip().rstrip('```').strip()
    return content

def pass1(image_data_url, question, reference_text):
    messages = [
        {'role':'system','content':'You are a visual assistant. Return strict JSON with keys view, needs_view, targets, reply_hint.'},
        {'role':'user','content': f'Reference:\n{reference_text}\nQuestion: {question}\nImage: {image_data_url}'},
    ]
    try:
        resp = _post_chat(messages)
        content = _extract_content(resp)
        return json.loads(content)
    except Exception:
        # retry with stricter reminder
        messages[0]['content'] = 'Return ONLY valid JSON, no markdown.'
        resp = _post_chat(messages)
        content = _extract_content(resp)
        return json.loads(content)

def pass2(view, targets, question):
    messages = [{'role':'system','content':'Explain using found regions.'},{'role':'user','content': question}]
    resp = _post_chat(messages)
    return resp['choices'][0]['message']['content']
