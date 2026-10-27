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
        'For micro-HDMI, emit TWO targets: id micro_hdmi_port_0 left, id micro_hdmi_port_1 right, part micro_hdmi_port. '
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

def refine_box(image_pil, box_1000, description, timeout=120):
    import re
    from PIL import Image
    w,h = image_pil.size
    x1,y1,x2,y2 = box_1000
    # convert to pixel coords
    x1p = int(x1/1000*w)
    y1p = int(y1/1000*h)
    x2p = int(x2/1000*w)
    y2p = int(y2/1000*h)
    bw = max(1, x2p - x1p)
    bh = max(1, y2p - y1p)
    pad = 1.0
    cx1 = max(0, x1p - int(bw*pad))
    cy1 = max(0, y1p - int(bh*pad))
    cx2 = min(w, x2p + int(bw*pad))
    cy2 = min(h, y2p + int(bh*pad))
    cw = max(cx2-cx1, 200)
    ch = max(cy2-cy1, 200)
    cx2 = min(w, cx1 + cw)
    cy2 = min(h, cy1 + ch)
    crop = image_pil.crop((cx1,cy1,cx2,cy2))
    crop = crop.resize((crop.width*3, crop.height*3))
    # encode crop
    import io, base64
    buf = io.BytesIO()
    crop.save(buf, format='JPEG', quality=90)
    data_url = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()
    prompt = f'This crop shows {description} somewhere near its centre. Reply ONLY with a TIGHT bounding box [x1,y1,x2,y2] of exactly that part, in 0..1000 coordinates of this crop.'
    messages = [
        {'role':'system','content':'Return ONLY a bounding box [x1,y1,x2,y2] in 0..1000 coordinates. No extra text.'},
        {'role':'user','content':[
            {'type':'image_url','image_url':{'url': data_url}},
            {'type':'text','text': prompt}
        ]}
    ]
    try:
        resp = _post_chat(messages, timeout=timeout, max_tokens=600)
        content = _extract_content(resp)
        if not content:
            return None
        m = re.search(r'\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]', content)
        if not m:
            return None
        rx1,ry1,rx2,ry2 = map(float, m.groups())
        # convert back to full frame 0..1000
        crop_w = cx2 - cx1
        crop_h = cy2 - cy1
        fx1 = (cx1 + rx1/1000*crop_w)
        fy1 = (cy1 + ry1/1000*crop_h)
        fx2 = (cx1 + rx2/1000*crop_w)
        fy2 = (cy1 + ry2/1000*crop_h)
        # convert to 0..1000
        fx1_1000 = fx1 / w * 1000
        fy1_1000 = fy1 / h * 1000
        fx2_1000 = fx2 / w * 1000
        fy2_1000 = fy2 / h * 1000
        return [fx1_1000, fy1_1000, fx2_1000, fy2_1000]
    except Exception:
        return None

def pass2(image_data_url, view, regions, question, reference_text):
    system_prompt = 'Explain in 2 sentences using the found region labels. Never output coordinates or boxes.'
    # Build region labels list
    region_descs = []
    for r in regions:
        label = r.get('label') or r.get('part')
        region_descs.append(f"{label}")
    regions_text = '; '.join(region_descs) if region_descs else 'none'
    user_content = [
        {'type':'image_url','image_url':{'url': image_data_url}},
        {'type':'text','text': f'Reference:\n{reference_text}\nView: {view}\nRegions: {regions_text}\nQuestion: {question}'}
    ]
    messages = [
        {'role':'system','content': system_prompt},
        {'role':'user','content': user_content}
    ]
    resp = _post_chat(messages, timeout=120, max_tokens=300)
    content = _extract_content(resp)
    if content is None:
        raise GlimmerError('glimmer_truncated')
    return content

def pick_candidate(image_pil, description, n):
    import io, base64, re
    buf = io.BytesIO()
    image_pil.save(buf, format='JPEG', quality=90)
    data_url = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()
    system_prompt = f'Return ONLY a single integer between 0 and {n-1} inclusive, or -1 if none matches. No extra text.'
    user_text = f'Numbered yellow boxes mark candidate parts on this image. Which box number is exactly {description}? Reply ONLY with the number, or -1 if none.'
    messages = [
        {'role':'system','content': system_prompt},
        {'role':'user','content': [
            {'type':'image_url','image_url':{'url': data_url}},
            {'type':'text','text': user_text}
        ]}
    ]
    try:
        resp = _post_chat(messages, timeout=120, max_tokens=300)
        content = _extract_content(resp)
        if not content:
            return None
        m = re.search(r'-?\d+', content)
        if not m:
            return None
        num = int(m.group())
        if num == -1 or num < 0 or num >= n:
            return None
        return num
    except Exception:
        return None
