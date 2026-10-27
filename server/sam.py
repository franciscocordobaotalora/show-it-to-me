import os, threading, sys
_lock = threading.Lock()
_model = None
_processor = None

class FakeSam:
    def segment(self, image, prompt):
        return []

def _load():
    global _model, _processor
    if _model is not None:
        return
    try:
        import torch
        from sam3 import build_sam3_image_model, Sam3Processor
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
        from PIL import Image
    except Exception as e:
        raise RuntimeError(f'sam_unavailable: {e}')
    with _lock:
        with torch.inference_mode():
            with torch.autocast('cuda', dtype=torch.bfloat16):
                # placeholder: real implementation would use processor
                # For offline tests, return empty
                return None
