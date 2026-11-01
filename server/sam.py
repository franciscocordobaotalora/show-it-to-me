import os, threading
_lock = threading.Lock()
_model = None
_processor = None

class FakeSam:
    def segment(self, image, prompt):
        return []

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
                        return {'polygon':polygon,'bbox':bbox,'score':best_score,'selection':'box_prompt'}

                    # Determine prompts: Pi-specific if part is known Pi part, else generic uses sam_prompt
                    try:
                        from reference import get_part_sam_prompts, get_part_visual, KNOWN_PI_PARTS
                        if part and part in KNOWN_PI_PARTS:
                            prompts = get_part_sam_prompts(part)
                            description = get_part_visual(part) or part
                        else:
                            # generic open vocabulary: single prompt from sam_prompt or label
                            prompts = [sam_prompt_val or label or part or '']
                            description = sam_prompt_val or label or part or ''
                            prompts = [p for p in prompts if p]
                    except Exception:
                        prompts = [sam_prompt_val or label or part or '']
                        description = sam_prompt_val or label or part or ''

                    gx1 = box_1000[0]/1000.0*self.w
                    gy1 = box_1000[1]/1000.0*self.h
                    gx2 = box_1000[2]/1000.0*self.w
                    gy2 = box_1000[3]/1000.0*self.h
                    glimmer_box_px = [gx1,gy1,gx2,gy2]

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
                                candidates.append({'box':b,'mask':masks[i],'score':scores_np[i]})
                        candidates.sort(key=lambda x:x['score'], reverse=True)
                        candidates = candidates[:24]
                    finally:
                        _processor.confidence_threshold = orig_thresh

                    candidates = [c for c in candidates if not self._is_used(c['box'])]

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
                        return {'polygon':polygon,'bbox':bbox,'score':float(cand['score']),'selection':selection}

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

                    if box_1000:
                        cxcywh = box1000_to_cxcywh(box_1000)
                        _processor.add_geometric_prompt(box=cxcywh, label=True, state=self.state)
                        masks = self.state.get('masks')
                        scores = self.state.get('scores')
                        boxes = self.state.get('boxes')
                        if masks is not None and boxes is not None and scores is not None:
                            boxes_np = [b.tolist() for b in boxes]
                            best_idx2, best_iou2 = pick_by_iou(boxes_np, glimmer_box_px)
                            if best_idx2 is not None and best_iou2 >=0.3:
                                mask = masks[best_idx2].cpu().numpy()
                                if mask.ndim==3:
                                    mask = mask[0]
                                polygon = mask_to_polygon(mask, self.w, self.h)
                                ys,xs = np.where(mask>0)
                                bbox = [0.0,0.0,0.0,0.0] if xs.size==0 else [float(xs.min())/self.w, float(ys.min())/self.h, float(xs.max())/self.w, float(ys.max())/self.h]
                                score = float(scores[best_idx2].item())
                                self._mark_used(boxes_np[best_idx2])
                                return {'polygon':polygon,'bbox':bbox,'score':score,'selection':'box_prompt'}
                    sam_prompt = target.get('sam_prompt','')
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
                            return {'polygon':polygon,'bbox':bbox,'score':best_score,'selection':'box_prompt'}
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
