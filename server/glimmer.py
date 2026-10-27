import os, json, urllib.request

MUSE_API_BASE = os.getenv('MUSE_API_BASE','')
MUSE_API_KEY = os.getenv('MUSE_API_KEY','')
MODEL = 'muse-glimmer-hackathon'

def _post_chat(messages, timeout=120, max_tokens=None):
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
    if max_tokens is not None:
        payload['max_tokens'] = max_tokens
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
    content = msg.get('content')
    if content is None:
        return None
    if content.strip().startswith('```'):
        content = content.strip()[3:]
        if content.startswith('json'):
            content = content[4:]
        content = content.strip().rstrip('```').strip()
    return content

def pass1(image_data_url, question, reference_text):
    system_prompt = (
        'Return strict JSON with keys view, needs_view, targets. '
        'Each target has id, part, sam_prompt, box_1000. '
        'Boxes are x1,y1,x2,y2 in 0..1000 of the image shown. '
        'Allowed parts: fan_connector, usb_c_power_port, micro_hdmi_port, microsd_slot, active_cooler_fan, board. '
        'view is top|underside|unknown. '
        'Example: {"view":"top","needs_view":null,"targets":[{"id":"1","part":"fan_connector","sam_prompt":"fan header","box_1000":[100,200,300,400]}]}'
    )
    user_content = [
        {'type':'image_url','image_url':{'url': image_data_url}},
        {'type':'text','text': f'Reference:\n{reference_text}\nQuestion: {question}'}
    ]
    messages = [
        {'role':'system','content': system_prompt},
        {'role':'user','content': user_content},
    ]
    try:
        resp = _post_chat(messages, timeout=120, max_tokens=900)
        content = _extract_content(resp)
        if content is None:
            raise GlimmerError('glimmer_truncated')
        return json.loads(content)
    except GlimmerError:
        raise
    except json.JSONDecodeError:
        # retry keeping image part
        messages[0]['content'] = 'Return ONLY valid JSON, no markdown, no reasoning.'
        try:
            resp = _post_chat(messages, timeout=120, max_tokens=900)
            content = _extract_content(resp)
            if content is None:
                raise GlimmerError('glimmer_truncated')
            return json.loads(content)
        except GlimmerError:
            raise
        except Exception:
            raise GlimmerError('glimmer_bad_json')
    except TimeoutError:
        raise GlimmerError('glimmer_timeout')
    except Exception:
        raise GlimmerError('glimmer_unreachable')

def pass2(image_data_url, view, regions, question, reference_text):
    system_prompt = 'Explain in 2-3 sentences using the found region labels. Never output coordinates or boxes.'
    # Build region labels list
    region_descs = []
    for r in regions:
        label = r.get('label') or r.get('part')
        region_descs.append(f"{r.get('id')}: {label} ({r.get('part')})")
    regions_text = '; '.join(region_descs) if region_descs else 'none'
    user_content = [
        {'type':'image_url','image_url':{'url': image_data_url}},
        {'type':'text','text': f'Reference:\n{reference_text}\nView: {view}\nRegions: {regions_text}\nQuestion: {question}'}
    ]
    messages = [
        {'role':'system','content': system_prompt},
        {'role':'user','content': user_content}
    ]
    resp = _post_chat(messages, timeout=120, max_tokens=600)
    content = _extract_content(resp)
    if content is None:
        raise GlimmerError('glimmer_truncated')
    return content
