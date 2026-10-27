import os, threading
_lock = threading.Lock()
_model = None
_processor = None
_image_state_cache = {}

class FakeSam:
    def segment(self, image, prompt):
        return []

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
        pts = []
        for p in approx.reshape(-1, 2):
            x_norm = float(p[0]) / w
            y_norm = float(p[1]) / h
            pts.append([x_norm, y_norm])
        if len(pts) > 60:
            pts = pts[:60]
        return pts
    except Exception:
        # Fallback pure-numpy bounding-box polygon when cv2 is unavailable
        ys, xs = np.where(mask)
        if xs.size == 0:
            return []
        x_min, x_max = xs.min(), xs.max()
        y_min, y_max = ys.min(), ys.max()
        pts = [
            [float(x_min)/w, float(y_min)/h],
            [float(x_max)/w, float(y_min)/h],
            [float(x_max)/w, float(y_max)/h],
            [float(x_min)/w, float(y_max)/h],
        ]
        return pts

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
    _load()
    try:
        import torch
        import cv2
        import numpy as np
    except Exception as e:
        raise RuntimeError(f'sam_unavailable: {e}')
    with _lock:
        with torch.inference_mode():
            with torch.autocast('cuda', dtype=torch.bfloat16):
                img_id = id(image_pil)
                w, h = image_pil.size
                if img_id not in _image_state_cache:
                    state = _processor.set_image(image_pil)
                    _image_state_cache[img_id] = state
                else:
                    state = _image_state_cache[img_id]
                state = _processor.reset_all_prompts(state)
                box_1000 = target.get('box_1000')
                sam_prompt = target.get('sam_prompt', '')
                if box_1000:
                    cxcywh = box1000_to_cxcywh(box_1000)
                    state = _processor.add_geometric_prompt(box=cxcywh, label=True, state=state)
                    masks = state.get('masks')
                    scores = state.get('scores')
                    boxes = state.get('boxes')
                    if masks is None or boxes is None:
                        return None
                    gx1 = box_1000[0] / 1000.0 * w
                    gy1 = box_1000[1] / 1000.0 * h
                    gx2 = box_1000[2] / 1000.0 * w
                    gy2 = box_1000[3] / 1000.0 * h
                    glimmer_box_px = [gx1, gy1, gx2, gy2]
                    boxes_np = [b.tolist() for b in boxes]
                    best_idx, best_iou = pick_by_iou(boxes_np, glimmer_box_px)
                    if best_idx is None or best_iou < 0.3:
                        return None
                    mask = masks[best_idx].cpu().numpy()
                    if mask.ndim == 3:
                        mask = mask[0]
                    polygon = mask_to_polygon(mask, w, h)
                    ys, xs = np.where(mask > 0)
                    if xs.size == 0:
                        bbox = [0.0, 0.0, 0.0, 0.0]
                    else:
                        bbox = [float(xs.min())/w, float(ys.min())/h, float(xs.max())/w, float(ys.max())/h]
                    score = float(scores[best_idx].item()) if scores is not None else 0.0
                    return {'polygon': polygon, 'bbox': bbox, 'score': score}
                else:
                    state = _processor.set_text_prompt(sam_prompt, state)
                    masks = state.get('masks')
                    scores = state.get('scores')
                    if masks is None or scores is None or len(scores) == 0:
                        return None
                    best_idx = int(torch.argmax(scores).item())
                    best_score = float(scores[best_idx].item())
                    if best_score < 0.3:
                        return None
                    mask = masks[best_idx].cpu().numpy()
                    if mask.ndim == 3:
                        mask = mask[0]
                    polygon = mask_to_polygon(mask, w, h)
                    ys, xs = np.where(mask > 0)
                    if xs.size == 0:
                        bbox = [0.0, 0.0, 0.0, 0.0]
                    else:
                        bbox = [float(xs.min())/w, float(ys.min())/h, float(xs.max())/w, float(ys.max())/h]
                    return {'polygon': polygon, 'bbox': bbox, 'score': best_score}
