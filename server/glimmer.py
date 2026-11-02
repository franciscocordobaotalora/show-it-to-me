import os, json, time, threading, urllib.request
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED

MUSE_API_BASE = os.getenv('MUSE_API_BASE','')
MUSE_API_KEY = os.getenv('MUSE_API_KEY','')
MODEL = os.getenv('MUSE_MODEL','muse-glimmer-hackathon')
MIN_TOKENS = int(os.getenv('MUSE_MIN_TOKENS','0'))  # reasoning models need room for thinking before the JSON
# Meta Model API takes the thinking level as `reasoning_effort` (minimal, low, medium, high). The "Reasoning strength: low"
# system line is a Baseten convention and Meta ignores it. Measured 2026-11-02: minimal 3.5 to 4.1 s, low 6.6 to 7.1 s.
REASONING_EFFORT = os.getenv('MUSE_REASONING_EFFORT','')
# Hedged requests: if no answer after HEDGE_S seconds, send the identical request again and use whichever returns first.
# One Muse call took 35 s on 2026-11-02 against 4 to 7 s normally; the second request escapes that tail.
HEDGE_S = float(os.getenv('MUSE_HEDGE_S','0'))
# Sampling: unset means the API default. Set MUSE_TEMPERATURE=0 (and optionally MUSE_SEED) for repeatable answers and boxes.
TEMPERATURE = os.getenv('MUSE_TEMPERATURE','')
SEED = os.getenv('MUSE_SEED','')

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
    }
    if REASONING_EFFORT:
        payload['reasoning_effort'] = REASONING_EFFORT
    elif os.getenv('MUSE_REASONING_IN_SYSTEM'):
        # Baseten takes the reasoning level from the system message; measured 6.1 s vs 11.1 s with the template kwarg.
        msgs = [dict(m) for m in messages]
        if msgs and msgs[0].get('role') == 'system' and isinstance(msgs[0].get('content'), str):
            msgs[0]['content'] += ' Reasoning strength: low'
        else:
            msgs.insert(0, {'role':'system','content':'Reasoning strength: low'})
        payload['messages'] = msgs
    else:
        payload['chat_template_kwargs'] = {'reasoning_strength':'low'}
    if TEMPERATURE != '':
        payload['temperature'] = float(TEMPERATURE)
    if SEED != '':
        payload['seed'] = int(SEED)
    if max_tokens is not None:
        payload['max_tokens'] = max(max_tokens, MIN_TOKENS)
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method='POST')
    req.add_header('Content-Type','application/json')
    req.add_header('Authorization', f'Bearer {MUSE_API_KEY}')
    def once():
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
        return json.loads(body)
    if HEDGE_S <= 0:
        return once()
    return _hedged(once, HEDGE_S)

def _log(event, **fields):
    try:
        import eventlog
        eventlog.log_event(event, **fields)
    except Exception:
        pass

def _hedged(fn, hedge_s):
    """Run fn(); if it has not finished after hedge_s seconds, run it a second time in parallel and return the first success.
    If one attempt fails the other is awaited; if both fail the first error is raised. Losers are not waited for."""
    ex = ThreadPoolExecutor(max_workers=2)
    t0 = time.time()
    try:
        first = ex.submit(fn)
        done, _ = wait([first], timeout=hedge_s)
        if done:
            return first.result()
        second = ex.submit(fn)
        pending = {first: 'first', second: 'second'}
        errors = []
        while pending:
            done, _ = wait(list(pending), return_when=FIRST_COMPLETED)
            for f in done:
                which = pending.pop(f)
                try:
                    r = f.result()
                except Exception as e:
                    errors.append(e)
                    continue
                _log('hedge_fired', level='info', winner=which, ms=int((time.time()-t0)*1000), hedge_s=hedge_s)
                return r
        _log('hedge_fired', level='warn', winner='none', ms=int((time.time()-t0)*1000), hedge_s=hedge_s)
        raise errors[0]
    finally:
        ex.shutdown(wait=False, cancel_futures=True)

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
        'You are a helpful visual guide. Answer the user question about WHATEVER is in the photo. '
        'Return strict JSON with keys is_pi_board, view, needs_view, targets, answer. '
        'is_pi_board is boolean true if the photo shows a Raspberry Pi 5 board, else false. '
        'view is top|underside|unknown — for Pi board use top/underside/unknown, otherwise unknown is fine. '
        'needs_view is null|flip_board|closer — ONLY set for Pi board when microSD slot is needed but view is top; otherwise null. '
        'Each target has id, label (2 to 4 words, human readable), sam_prompt (a short noun phrase SAM can find, e.g. "white connector", "power port"), box_1000 (x1,y1,x2,y2 in 0..1000 of the image shown). '
        'No allowed-parts list — describe whatever the question is about. '
        'POINTING: when the question says this, that, here, it, or this part, look for a pointing finger or a hand touching the object. If a fingertip is on a part, the target is that single small part: ONE tight box around it only, never the whole device, and name that part in the label. If no fingertip is visible, treat it as a general question and use the main object as the target. '
        'If is_pi_board is true you MAY use precise Pi 5 part names from the OPTIONAL reference for label and sam_prompt and keep overlay labels precise; otherwise use generic description. '
        'For micro-HDMI on Pi, emit TWO targets: id micro_hdmi_port_0 left, id micro_hdmi_port_1 right, label "micro-HDMI port". '
        'answer is 2 to 3 plain sentences that explain what the thing is and what it does, in the same language as the question (reply in the language of the question). Never include ids or coordinates in the answer. '
        'Example generic: {"is_pi_board":false,"view":"unknown","needs_view":null,"answer":"This is a ceramic mug for drinking hot beverages. It keeps the liquid warm and has a handle for easy holding.","targets":[{"id":"1","label":"ceramic mug","sam_prompt":"mug","box_1000":[100,200,300,400]}]} '
        'Example Pi: {"is_pi_board":true,"view":"top","needs_view":null,"answer":"The fan header is at the top edge of the Pi 5. It provides power for the active cooler fan.","targets":[{"id":"1","label":"FAN header","sam_prompt":"fan header","box_1000":[100,200,300,400]}]}'
    )
    user_content = [
        {'type':'image_url','image_url':{'url': image_data_url}},
        {'type':'text','text': f'OPTIONAL Pi 5 reference (only use if is_pi_board true, otherwise ignore and answer generically):\n{reference_text}\nQuestion: {question}'}
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

def scan(image_data_url):
    """One Muse vision call to list 3-8 salient objects with boxes + caption."""
    system_prompt = (
        'You are a visual scanner. List the 3 to 8 most salient distinct things in the photo. '
        'Return strict JSON {"caption": string (one sentence describing the scene), '
        '"objects": [{"label": string (2-4 words human readable), "sam_prompt": string (short noun phrase for segmentation, e.g. "mug", "white connector"), "box_1000": [x1,y1,x2,y2] in 0..1000}]}. '
        'Choose diverse, clearly visible objects. No duplicates. Boxes must tightly enclose each object.'
    )
    messages = [
        {'role':'system','content': system_prompt},
        {'role':'user','content':[
            {'type':'image_url','image_url':{'url': image_data_url}},
            {'type':'text','text': 'Scan this image: list salient objects with boxes and a short caption.'}
        ]}
    ]
    try:
        resp = _post_chat(messages, timeout=60, max_tokens=900)
        content = _extract_content(resp)
        if content is None:
            raise GlimmerError('glimmer_truncated')
        return json.loads(content)
    except GlimmerError:
        raise
    except json.JSONDecodeError:
        raise GlimmerError('glimmer_bad_json')
    except TimeoutError:
        raise GlimmerError('glimmer_timeout')
    except Exception:
        raise GlimmerError('glimmer_unreachable')

def scan_answer(objects, caption, question):
    """TEXT-ONLY Muse call (no image). Given objects [labels,boxes] and caption, answer question and say which objects."""
    objs_text = '; '.join([f"{o.get('label')} at {o.get('box_1000')}" for o in objects]) if objects else 'none'
    system_prompt = 'You are a helpful visual guide. Given these objects and the scene caption, answer the question. Return strict JSON {"answer": string (2-3 sentences in same language as question), "selected": [string labels of relevant objects from the list]}. Only use labels that appear exactly in the provided list.'
    user_text = f"Caption: {caption}\nObjects: {objs_text}\nQuestion: {question}\nReturn JSON with answer and selected labels."
    messages = [
        {'role':'system','content': system_prompt},
        {'role':'user','content': [{'type':'text','text': user_text}]}
    ]
    try:
        resp = _post_chat(messages, timeout=60, max_tokens=400)
        content = _extract_content(resp)
        if content is None:
            raise GlimmerError('glimmer_truncated')
        return json.loads(content)
    except GlimmerError:
        raise
    except json.JSONDecodeError:
        raise GlimmerError('glimmer_bad_json')
    except TimeoutError:
        raise GlimmerError('glimmer_timeout')
    except Exception as e:
        raise GlimmerError('glimmer_unreachable')

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
