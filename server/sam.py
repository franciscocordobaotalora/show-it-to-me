class FakeSam:
    def segment(self, image, prompt):
        return []

def segment(image, prompt):
    try:
        # Real SAM import would go here in T03B
        raise ImportError('SAM not implemented')
    except Exception as e:
        raise RuntimeError('sam_unavailable')
