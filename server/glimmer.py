import os, json, urllib.request

MUSE_API_BASE = os.getenv('MUSE_API_BASE','')
MUSE_API_KEY = os.getenv('MUSE_API_KEY','')
MODEL = 'muse-glimmer-hackathon'

def _post_chat(messages, timeout=120):
    if not MUSE_API_BASE or not MUSE_API_KEY:
        raise RuntimeError('Muse API not configured')
    url = MUSE_API_BASE.rstrip('/') + '/v1/chat/completions'
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

def pass1(image_data_url, question, reference_text):
    messages = [
        {'role':'system','content':'You are a visual assistant. Return strict JSON.'},
        {'role':'user','content': f'Reference:\n{reference_text}\nQuestion: {question}'},
    ]
    # image included via data URL in content? Simplified
    resp = _post_chat(messages)
    content = resp['choices'][0]['message']['content']
    return json.loads(content)

def pass2(view, targets, question):
    messages = [{'role':'system','content':'Explain using found regions.'},{'role':'user','content': question}]
    resp = _post_chat(messages)
    return resp['choices'][0]['message']['content']
