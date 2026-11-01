import os, threading
_lock = threading.Lock()
_model = None
_processor = None

class FakeSam:
    def segment(self, image, prompt):
        return []

# --- Helpers for generic grounding (pure, testable without GPU) ---

ADJECTIVES = {
    "small","large","big","tiny","little","huge",
    "black","white","silver","red","blue","green","yellow","brown","gray","grey",
    "metal","metallic","plastic","ceramic","wooden","steel","chrome","shiny","dark","light",
    "upper","lower","front","rear","top","bottom","left","right",
    "clear","transparent","matte","glossy",
}

def strip_adjectives(prompt: str) -> str:
    """Return prompt without leading/trailing adjectives. If no change, return original."""
    if not prompt or not isinstance(prompt, str):
        return prompt
    words = prompt.strip().split()
    if len(words) <= 1:
        return prompt
    # Filter words that are in ADJECTIVES (case-insensitive)
    filtered = [w for w in words if w.lower() not in ADJECTIVES]
    if not filtered:
        # keep last word as noun fallback
        return words[-1]
    stripped = " ".join(filtered)
    # If stripped same as original (no adjectives removed), try last-word fallback if multiple words?
    # But ticket says sam_prompt without adjectives – we return filtered if different
    if stripped.lower() == prompt.strip().lower():
        return prompt
    return stripped

def build_generic_prompts(sam_prompt: str, label: str) -> list:
    """Build list of text prompts for generic open-vocab: sam_prompt + label + stripped sam_prompt."""
    prompts = []
    seen = set()
    def add(p):
        if not p or not isinstance(p, str):
            return
        p = p.strip()
        if not p:
            return
        low = p.lower()
        if low not in seen:
            seen.add(low)
            prompts.append(p)
    # primary sam_prompt
    if sam_prompt:
        add(sam_prompt)
        # stripped variant
        stripped = strip_adjectives(sam_prompt)
        if stripped and stripped.lower() != sam_prompt.strip().lower():
            add(stripped)
            # also try last-word fallback if still multi-word
            if " " in stripped:
                last = stripped.split()[-1]
                if last.lower() not in seen:
                    add(last)
    # label alternate (if different)
    if label:
        if label.strip().lower() not in seen:
            add(label)
            # also stripped label?
            stripped_label = strip_adjectives(label)
            if stripped_label and stripped_label.lower() not in seen and stripped_label.lower() != label.strip().lower():
                add(stripped_label)
    return prompts

def bbox_area_ratio(bbox_norm, frame_area=1.0):
    """bbox in normalized [0,1] coords [x1,y1,x2,y2], compute area ratio."""
    if not bbox_norm or len(bbox_norm)!=4:
        return 0.0
    w = max(0.0, bbox_norm[2]-bbox_norm[0])
    h = max(0.0, bbox_norm[3]-bbox_norm[1])
    return (w*h) / frame_area if frame_area>0 else 0.0

def is_plausible_area(area_ratio: float) -> bool:
    return 0.001 <= area_ratio <= 0.60

def score_text_candidates(candidates, glimmer_box_px):
    """
    Score candidates by IoU with glimmer_box and SAM score.
    candidates: list of dict with 'box' (px), 'score'
    Returns (best_candidate, best_iou, best_score) where best has IoU>=0.3 and highest score.
    If none qualifies, returns (None, None, None)
    """
    best = None
    best_iou = 0.0
    best_score = 0.0
    for c in candidates:
        v = iou(c['box'], glimmer_box_px)
        # keep debug iou on candidate for later
        c['_iou'] = v
        if v >= 0.3:
            if best is None or c['score'] > best_score or (c['score']==best_score and v > best_iou):
                best = c
                best_iou = v
                best_score = c['score']
    if best is None:
        return None, None, None
    return best, best_iou, best_score

def compute_agreement_iou(box_a, box_b):
    """Compute IoU between two boxes (px or normalized, same coords)."""
    return iou(box_a, box_b)

def choose_preferred_on_disagreement(text_cand, box_cand, glimmer_box_px, frame_area=1.0):
    """
    When both exist and disagree (IoU <0.2 between their boxes), prefer one closer to Muse box AND plausible area.
    text_cand/box_cand are dicts with 'box' (px or norm?) and 'bbox' (norm) and 'score'
    For synthetic tests, we support both px and norm: we check which coords available.
    Returns preferred candidate and reason string.
    """
    # compute IoUs with glimmer
    text_iou = iou(text_cand['box'], glimmer_box_px) if 'box' in text_cand else 0
    box_iou = iou(box_cand['box'], glimmer_box_px) if 'box' in box_cand else 0
    # compute area ratios from bbox normalized if available, else from box px vs frame_area
    def area_ratio(cand):
        if 'bbox' in cand and cand['bbox']:
            return bbox_area_ratio(cand['bbox'], 1.0)
        elif 'box' in cand and frame_area:
            b = cand['box']
            w = max(0, b[2]-b[0])
            h = max(0, b[3]-b[1])
            return (w*h)/frame_area if frame_area else 0
        return 0
    text_area = area_ratio(text_cand)
    box_area = area_ratio(box_cand)
    text_plausible = is_plausible_area(text_area)
    box_plausible = is_plausible_area(box_area)

    # Prefer closer to Muse box AND plausible
    # If only one plausible, pick that
    if text_plausible and not box_plausible:
        return text_cand, 'text_plausible'
    if box_plausible and not text_plausible:
        return box_cand, 'box_plausible'
    # Both plausible or both not: pick higher IoU with glimmer
    if text_iou > box_iou:
        return text_cand, 'closer_text'
    elif box_iou > text_iou:
        return box_cand, 'closer_box'
    else:
        # tie: prefer higher SAM score
        if text_cand.get('score',0) >= box_cand.get('score',0):
            return text_cand, 'higher_score_text'
        else:
            return box_cand, 'higher_score_box'


class SamSession:
    _used = {}

    def __init__(self, image_pil):
        _load()
        self.w, self.h = image_pil.size
        self.image = image_pil
        self._image_id = id(image_pil)
        if self._image_id not in SamSession._used:
            SamSession._used[self._image_id] = set()
        import torch
        with _lock:
            with torch.inference_mode():
                with torch.autocast('cuda', dtype=torch.bfloat16):
                    self.state = _processor.set_image(image_pil)

    def _is_used(self, box_px):
        used = SamSession._used[self._image_id]
        for ub in used:
            if iou(box_px, list(ub)) > 0.9:
                return True
        return False

    def _mark_used(self, box_px):
        SamSession._used[self._image_id].add(tuple(box_px))

    def segment(self, target):
        try:
            import torch
            import numpy as np
        except Exception as e:
            raise RuntimeError(f'sam_unavailable: {e}')
        with _lock:
            with torch.inference_mode():
                with torch.autocast('cuda', dtype=torch.bfloat16):
                    _processor.reset_all_prompts(self.state)
                    box_1000 = target.get('box_1000')
                    part = target.get('part')
                    label = target.get('label')
                    sam_prompt_val = target.get('sam_prompt','')
                    # generic open vocabulary: if no box, simple text prompt path
                    if not box_1000:
                        sam_prompt = sam_prompt_val or label or part or ''
                        _processor.set_text_prompt(sam_prompt, self.state)
                        masks = self.state.get('masks')
                        scores = self.state.get('scores')
                        if masks is None or scores is None or len(scores)==0:
                            return None
                        best_idx = int(torch.argmax(scores).item())
                        best_score = float(scores[best_idx].item())
                        if best_score < 0.3:
                            return None
                        mask = masks[best_idx].cpu().numpy()
                        if mask.ndim==3:
                            mask = mask[0]
                        polygon = mask_to_polygon(mask, self.w, self.h)
                        ys,xs = np.where(mask>0)
                        bbox = [0.0,0.0,0.0,0.0] if xs.size==0 else [float(xs.min())/self.w, float(ys.min())/self.h, float(xs.max())/self.w, float(ys.max())/self.h]
                        return {'polygon':polygon,'bbox':bbox,'score':best_score,'selection':'box_prompt', 'selection_debug': {'text_score': None, 'box_score': best_score, 'text_iou': None, 'box_iou': None}}

                    # Determine prompts: Pi-specific if part is known Pi part, else generic uses sam_prompt
                    try:
                        from reference import get_part_sam_prompts, get_part_visual, KNOWN_PI_PARTS
                        is_pi = part and part in KNOWN_PI_PARTS
                        if is_pi:
                            prompts = get_part_sam_prompts(part)
                            description = get_part_visual(part) or part
                        else:
                            prompts = build_generic_prompts(sam_prompt_val, label or part or '')
                            description = sam_prompt_val or label or part or ''
                            prompts = [p for p in prompts if p]
                    except Exception:
                        prompts = [sam_prompt_val or label or part or '']
                        description = sam_prompt_val or label or part or ''
                        is_pi = False

                    gx1 = box_1000[0]/1000.0*self.w
                    gy1 = box_1000[1]/1000.0*self.h
                    gx2 = box_1000[2]/1000.0*self.w
                    gy2 = box_1000[3]/1000.0*self.h
                    glimmer_box_px = [gx1,gy1,gx2,gy2]
                    frame_area = self.w * self.h

                    orig_thresh = getattr(_processor,'confidence_threshold',0.3)
                    try:
                        _processor.confidence_threshold = 0.25
                        candidates = []
                        for prompt in prompts:
                            _processor.reset_all_prompts(self.state)
                            _processor.set_text_prompt(prompt, self.state)
                            masks = self.state.get('masks')
                            scores = self.state.get('scores')
                            boxes = self.state.get('boxes')
                            if masks is None or boxes is None or scores is None:
                                continue
                            boxes_np = [b.tolist() for b in boxes]
                            scores_np = [float(s.item()) for s in scores]
                            for i,b in enumerate(boxes_np):
                                b1000 = [b[0]/self.w*1000, b[1]/self.h*1000, b[2]/self.w*1000, b[3]/self.h*1000]
                                wbox = b1000[2]-b1000[0]
                                hbox = b1000[3]-b1000[1]
                                if wbox >=200 or hbox >=250:
                                    continue
                                dup = False
                                for c in candidates:
                                    if iou(b, c['box']) >=0.7:
                                        dup = True
                                        break
                                if dup:
                                    continue
                                candidates.append({'box':b,'mask':masks[i],'score':scores_np[i], 'prompt': prompt})
                        candidates.sort(key=lambda x:x['score'], reverse=True)
                        candidates = candidates[:24]
                    finally:
                        _processor.confidence_threshold = orig_thresh

                    candidates = [c for c in candidates if not self._is_used(c['box'])]

                    # --- Generic grounding logic vs Pi logic ---
                    if is_pi:
                        # Pi path: existing overlap 0.5 -> marks -> 0.25 logic
                        best_iou = -1.0
                        best_idx = None
                        for i,c in enumerate(candidates):
                            v = iou(c['box'], glimmer_box_px)
                            if v > best_iou:
                                best_iou = v
                                best_idx = i

                        def make_result(cand, selection):
                            mask = cand['mask'].cpu().numpy()
                            if mask.ndim==3:
                                mask = mask[0]
                            polygon = mask_to_polygon(mask, self.w, self.h)
                            ys,xs = np.where(mask>0)
                            bbox = [0.0,0.0,0.0,0.0] if xs.size==0 else [float(xs.min())/self.w, float(ys.min())/self.h, float(xs.max())/self.w, float(ys.max())/self.h]
                            self._mark_used(cand['box'])
                            # compute debug: text vs box scores not relevant for Pi, but fill
                            return {'polygon':polygon,'bbox':bbox,'score':float(cand['score']),'selection':selection, 'selection_debug': {'text_score': float(cand['score']), 'box_score': None, 'text_iou': best_iou if best_idx is not None else None, 'box_iou': None}}

                        if best_idx is not None and best_iou >=0.5:
                            return make_result(candidates[best_idx],'overlap')

                        if len(candidates) >=2:
                            from PIL import ImageDraw, ImageFont
                            img_copy = self.image.copy()
                            draw = ImageDraw.Draw(img_copy)
                            try:
                                font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',22)
                            except Exception:
                                font = None
                            for i,c in enumerate(candidates):
                                b = c['box']
                                x1,y1,x2,y2 = b
                                draw.rectangle([x1,y1,x2,y2], outline=(255,255,0), width=2)
                                draw.rectangle([x1, max(0,y1-24), x1+30, y1], fill=(0,0,0))
                                draw.text((x1+3, y1-24), str(i), fill=(255,255,0), font=font)
                            try:
                                import glimmer
                                pick_idx = glimmer.pick_candidate(img_copy, description, len(candidates))
                            except Exception:
                                pick_idx = None
                            if pick_idx is not None and 0 <= pick_idx < len(candidates):
                                return make_result(candidates[pick_idx],'marks')

                        if best_idx is not None and best_iou >=0.25:
                            return make_result(candidates[best_idx],'overlap')

                        # fall through to box_prompt for Pi as generic
                    else:
                        # Generic open-vocab path: score text candidates with IoU>=0.3
                        text_best, text_iou_val, text_score_val = score_text_candidates(candidates, glimmer_box_px)
                        # Prepare text candidate info for agreement check (need box mask)
                        text_cand_for_agreement = None
                        if text_best is not None:
                            # text_best already has box, mask, score
                            text_cand_for_agreement = text_best

                    # Common box_prompt path (both Pi fallback and generic)
                    box_cand = None
                    box_score_val = None
                    box_iou_val = None
                    box_bbox = None
                    box_polygon = None
                    box_mask_for_refine = None
                    if box_1000:
                        cxcywh = box1000_to_cxcywh(box_1000)
                        _processor.add_geometric_prompt(box=cxcywh, label=True, state=self.state)
                        masks = self.state.get('masks')
                        scores = self.state.get('scores')
                        boxes = self.state.get('boxes')
                        if masks is not None and boxes is not None and scores is not None and len(scores)>0:
                            boxes_np = [b.tolist() for b in boxes]
                            best_idx2, best_iou2 = pick_by_iou(boxes_np, glimmer_box_px)
                            if best_idx2 is not None:
                                # we keep candidate even if IoU <0.3 for agreement check, but selection requires >=0.3 unless fallback
                                mask = masks[best_idx2].cpu().numpy()
                                if mask.ndim==3:
                                    mask = mask[0]
                                polygon = mask_to_polygon(mask, self.w, self.h)
                                ys,xs = np.where(mask>0)
                                bbox = [0.0,0.0,0.0,0.0] if xs.size==0 else [float(xs.min())/self.w, float(ys.min())/self.h, float(xs.max())/self.w, float(ys.max())/self.h]
                                score = float(scores[best_idx2].item())
                                # store box candidate for agreement and final
                                box_cand = {'box': boxes_np[best_idx2], 'mask': masks[best_idx2], 'score': score, 'bbox': bbox, 'polygon': polygon, 'iou_glimmer': best_iou2}
                                box_score_val = score
                                box_iou_val = best_iou2
                                box_bbox = bbox
                                box_polygon = polygon
                                box_mask_for_refine = masks[best_idx2]
                                # For Pi fallback we might need to return if IoU>=0.3
                                # But for generic we will handle after agreement
                        # If Pi and we have box candidate with sufficient IoU, we could return now (keeping old Pi behavior)
                        if is_pi and box_cand and box_cand.get('iou_glimmer',0) >=0.3:
                            # Pi box_prompt success
                            self._mark_used(box_cand['box'])
                            return {'polygon': box_cand['polygon'],'bbox': box_cand['bbox'],'score': box_cand['score'],'selection':'box_prompt', 'selection_debug': {'text_score': None, 'box_score': box_cand['score'], 'text_iou': None, 'box_iou': box_cand['iou_glimmer']}}

                    # Now handle generic decision with agreement check
                    if not is_pi:
                        # text_best defined above
                        # box_cand may be None
                        # Compute grounding agreement if both exist
                        agreement_iou = None
                        chosen = None
                        chosen_selection = None
                        if text_best is not None and box_cand is not None:
                            agreement_iou = compute_agreement_iou(text_best['box'], box_cand['box'])
                            # Prepare candidates for agreement resolver with required fields
                            text_for_resolve = {'box': text_best['box'], 'bbox': None, 'score': text_best['score']}
                            # compute bbox for text_best to get area: need to derive from mask
                            # We can compute bbox from mask quickly if needed for plausibility
                            # but we have not yet computed polygon/bbox for text_best; do it now lightly
                            try:
                                m_tmp = text_best['mask'].cpu().numpy()
                                if m_tmp.ndim==3:
                                    m_tmp = m_tmp[0]
                                import numpy as np
                                ys_tmp, xs_tmp = np.where(m_tmp>0)
                                tbbox = [0.0,0.0,0.0,0.0] if xs_tmp.size==0 else [float(xs_tmp.min())/self.w, float(ys_tmp.min())/self.h, float(xs_tmp.max())/self.w, float(ys_tmp.max())/self.h]
                                text_for_resolve['bbox'] = tbbox
                            except Exception:
                                text_for_resolve['bbox'] = None
                            box_for_resolve = {'box': box_cand['box'], 'bbox': box_cand['bbox'], 'score': box_cand['score']}
                            if agreement_iou < 0.2:
                                # disagree: prefer closer to Muse AND plausible area
                                preferred, reason = choose_preferred_on_disagreement(text_for_resolve, box_for_resolve, glimmer_box_px, frame_area)
                                # Map preferred back to actual candidate
                                if preferred is text_for_resolve:
                                    chosen = text_best
                                    chosen_selection = 'text_overlap'
                                else:
                                    chosen = box_cand
                                    chosen_selection = 'box_prompt'
                                # debug reason
                                selection_debug = {'text_score': text_score_val, 'box_score': box_score_val, 'text_iou': text_iou_val, 'box_iou': box_iou_val, 'agreement_iou': agreement_iou, 'disagreement': True, 'preferred_reason': reason}
                            else:
                                # agree: prefer text_overlap if it qualified
                                chosen = text_best
                                chosen_selection = 'text_overlap'
                                selection_debug = {'text_score': text_score_val, 'box_score': box_score_val, 'text_iou': text_iou_val, 'box_iou': box_iou_val, 'agreement_iou': agreement_iou, 'disagreement': False}
                            # return chosen
                            if chosen is not None:
                                # build polygon/bbox/score for chosen
                                if chosen_selection == 'text_overlap':
                                    # text_best needs polygon
                                    mask = chosen['mask'].cpu().numpy()
                                    if mask.ndim==3:
                                        mask = mask[0]
                                    polygon = mask_to_polygon(mask, self.w, self.h)
                                    ys,xs = np.where(mask>0)
                                    bbox = [0.0,0.0,0.0,0.0] if xs.size==0 else [float(xs.min())/self.w, float(ys.min())/self.h, float(xs.max())/self.w, float(ys.max())/self.h]
                                    self._mark_used(chosen['box'])
                                    return {'polygon':polygon,'bbox':bbox,'score':float(chosen['score']),'selection':chosen_selection, 'selection_debug': selection_debug}
                                else:
                                    self._mark_used(box_cand['box'])
                                    return {'polygon': box_cand['polygon'],'bbox': box_cand['bbox'],'score':float(box_cand['score']),'selection':chosen_selection, 'selection_debug': selection_debug}
                        elif text_best is not None:
                            # only text qualifies
                            selection_debug = {'text_score': text_score_val, 'box_score': box_score_val, 'text_iou': text_iou_val, 'box_iou': box_iou_val, 'agreement_iou': agreement_iou}
                            mask = text_best['mask'].cpu().numpy()
                            if mask.ndim==3:
                                mask = mask[0]
                            polygon = mask_to_polygon(mask, self.w, self.h)
                            ys,xs = np.where(mask>0)
                            bbox = [0.0,0.0,0.0,0.0] if xs.size==0 else [float(xs.min())/self.w, float(ys.min())/self.h, float(xs.max())/self.w, float(ys.max())/self.h]
                            self._mark_used(text_best['box'])
                            return {'polygon':polygon,'bbox':bbox,'score':float(text_best['score']),'selection':'text_overlap', 'selection_debug': selection_debug}
                        elif box_cand is not None:
                            # Only box candidate – check if IoU qualifies? Ticket says only if none qualifies use box, then refine if small
                            # We should still verify IoU >=0.2? But for generic we should return box even if IoU low, unless quality gate rejects later
                            # Check box area <15% frame for refine
                            box_area_ratio = ((box_1000[2]-box_1000[0])*(box_1000[3]-box_1000[1])) / (1000*1000)
                            # frame area in 1000 coords is 1e6, so ratio is area/1e6
                            if box_area_ratio < 0.15:
                                # try refine_box once
                                try:
                                    import glimmer
                                    if hasattr(glimmer, 'refine_box'):
                                        refined_box = glimmer.refine_box(self.image, box_1000, description)
                                        if refined_box and len(refined_box)==4:
                                            rx1,ry1,rx2,ry2 = refined_box
                                            if rx2>rx1 and ry2>ry1:
                                                # validate refined box not too large vs orig: we already have check in server, but here compare mask scores
                                                cxcywh_r = box1000_to_cxcywh(refined_box)
                                                _processor.reset_all_prompts(self.state)
                                                _processor.add_geometric_prompt(box=cxcywh_r, label=True, state=self.state)
                                                masks_r = self.state.get('masks')
                                                scores_r = self.state.get('scores')
                                                boxes_r = self.state.get('boxes')
                                                if masks_r is not None and scores_r is not None and boxes_r is not None and len(scores_r)>0:
                                                    best_idx_r = int(torch.argmax(scores_r).item())
                                                    score_r = float(scores_r[best_idx_r].item())
                                                    if score_r > box_cand['score']:
                                                        # keep refined
                                                        mask_r = masks_r[best_idx_r].cpu().numpy()
                                                        if mask_r.ndim==3:
                                                            mask_r = mask_r[0]
                                                        polygon_r = mask_to_polygon(mask_r, self.w, self.h)
                                                        ys_r,xs_r = np.where(mask_r>0)
                                                        bbox_r = [0.0,0.0,0.0,0.0] if xs_r.size==0 else [float(xs_r.min())/self.w, float(ys_r.min())/self.h, float(xs_r.max())/self.w, float(ys_r.max())/self.h]
                                                        box_r = boxes_r[best_idx_r].tolist()
                                                        self._mark_used(box_r)
                                                        return {'polygon':polygon_r,'bbox':bbox_r,'score':score_r,'selection':'box_prompt', 'selection_debug': {'text_score': None, 'box_score': score_r, 'refined': True, 'orig_score': box_score_val, 'text_iou': None, 'box_iou': box_iou_val}}
                                except Exception:
                                    pass
                            self._mark_used(box_cand['box'])
                            return {'polygon': box_cand['polygon'],'bbox': box_cand['bbox'],'score': float(box_cand['score']),'selection':'box_prompt', 'selection_debug': {'text_score': None, 'box_score': box_score_val, 'text_iou': None, 'box_iou': box_iou_val}}
                    # Fallback: try generic text prompt once more
                    sam_prompt = target.get('sam_prompt','')
                    _processor.reset_all_prompts(self.state)
                    _processor.set_text_prompt(sam_prompt, self.state)
                    masks = self.state.get('masks')
                    scores = self.state.get('scores')
                    if masks is not None and scores is not None and len(scores)>0:
                        best_idx = int(torch.argmax(scores).item())
                        best_score = float(scores[best_idx].item())
                        if best_score >=0.3:
                            mask = masks[best_idx].cpu().numpy()
                            if mask.ndim==3:
                                mask = mask[0]
                            polygon = mask_to_polygon(mask, self.w, self.h)
                            ys,xs = np.where(mask>0)
                            bbox = [0.0,0.0,0.0,0.0] if xs.size==0 else [float(xs.min())/self.w, float(ys.min())/self.h, float(xs.max())/self.w, float(ys.max())/self.h]
                            return {'polygon':polygon,'bbox':bbox,'score':best_score,'selection':'box_prompt', 'selection_debug': {'text_score': best_score, 'box_score': None, 'text_iou': None, 'box_iou': None}}
                    return None

def box1000_to_cxcywh(box):
    x1, y1, x2, y2 = box
    cx = ((x1 + x2) / 2.0) / 1000.0
    cy = ((y1 + y2) / 2.0) / 1000.0
    w = (x2 - x1) / 1000.0
    h = (y2 - y1) / 1000.0
    return [cx, cy, w, h]

def iou(a, b):
    x1 = max(a[0], b[0])
    y1 = max(a[1], b[1])
    x2 = min(a[2], b[2])
    y2 = min(a[3], b[3])
    inter_w = max(0.0, x2 - x1)
    inter_h = max(0.0, y2 - y1)
    inter = inter_w * inter_h
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    if union <= 0:
        return 0.0
    return float(inter / union)

def pick_by_iou(boxes, glimmer_box):
    best_idx = None
    best_iou = -1.0
    for i, b in enumerate(boxes):
        val = iou(b, glimmer_box)
        if val > best_iou:
            best_iou = val
            best_idx = i
    return best_idx, best_iou

def mask_to_polygon(mask_np, w, h):
    import numpy as np
    if mask_np is None:
        return []
    mask = np.asarray(mask_np)
    if mask.dtype != np.uint8:
        mask = (mask > 0).astype(np.uint8)
    else:
        mask = (mask > 0).astype(np.uint8)
    try:
        import cv2
        mask_uint8 = (mask * 255).astype(np.uint8)
        contours, _ = cv2.findContours(mask_uint8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return []
        largest = max(contours, key=cv2.contourArea)
        perimeter = cv2.arcLength(largest, True)
        epsilon = 0.004 * perimeter if perimeter > 0 else 0
        approx = cv2.approxPolyDP(largest, epsilon, True)
        while len(approx) > 60 and epsilon > 0:
            epsilon *= 1.5
            approx = cv2.approxPolyDP(largest, epsilon, True)
        pts = []
        for p in approx.reshape(-1, 2):
            x_norm = float(p[0]) / w
            y_norm = float(p[1]) / h
            pts.append([x_norm, y_norm])
        return pts
    except Exception:
        return []

def _load():
    global _model, _processor
    if _model is not None:
        return
    try:
        import torch
        from sam3.model_builder import build_sam3_image_model
        from sam3.model.sam3_image_processor import Sam3Processor
        checkpoint = os.getenv('SAM3_CHECKPOINT')
        if not checkpoint:
            raise RuntimeError('sam_unavailable: missing checkpoint')
        device = 'cuda'
        _model = build_sam3_image_model(device=device, checkpoint_path=checkpoint, load_from_HF=False)
        _processor = Sam3Processor(_model, device=device, confidence_threshold=0.3)
    except Exception as e:
        raise RuntimeError(f'sam_unavailable: {e}')

def segment(image_pil, target):
    session = SamSession(image_pil)
    return session.segment(target)


# Backend switch: SAM_BACKEND=meta serves SAM 3.1 from Meta Model API (no GPU, no torch). Default stays the local SAM 3.
if os.getenv('SAM_BACKEND', 'local') == 'meta':
    import sam_meta as _sam_meta

    def _load():
        _sam_meta.load()

    def segment(image_pil, target):
        return _sam_meta.segment(image_pil, target)
