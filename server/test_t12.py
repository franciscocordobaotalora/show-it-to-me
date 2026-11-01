import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import sam

def test_strip_adjectives():
    assert sam.strip_adjectives("small silver disc brake caliper") == "disc brake caliper"
    assert sam.strip_adjectives("espresso tamper") == "espresso tamper"  # no adjectives stripped
    assert sam.strip_adjectives("black metal ring") == "ring"

def test_build_generic_prompts_contains_alternates():
    prompts = sam.build_generic_prompts("small metal tamper", "espresso tamper")
    assert "small metal tamper" in prompts
    # stripped version should contain tamper or metal removed?
    assert any("tamper" in p for p in prompts)
    assert "espresso tamper" in prompts
    assert len(prompts) <= 4

def test_score_text_candidates_picks_best_iou_over_threshold():
    glimmer = [0,0,100,100]
    cands = [
        {'box':[10,10,50,50], 'score':0.9},  # iou ~0.16? check: inter 40*40=1600, union 10000+1600-1600=10000 =>0.16 <0.3 not qualify
        {'box':[0,0,90,90], 'score':0.6},   # iou 0.81 qualifies
        {'box':[5,5,95,95], 'score':0.95}, # iou ~0.90? qualifies highest score
    ]
    best, iou_val, score = sam.score_text_candidates(cands, glimmer)
    assert best is not None
    assert best['score']==0.95
    assert iou_val >=0.3

def test_score_none_when_no_iou_qualifies():
    glimmer = [0,0,10,10]
    cands = [{'box':[100,100,110,110], 'score':0.9}]
    best, iou_val, score = sam.score_text_candidates(cands, glimmer)
    assert best is None

def test_compute_agreement_iou():
    assert abs(sam.compute_agreement_iou([0,0,10,10],[5,5,15,15]) - 0.142857) < 0.01
    assert sam.compute_agreement_iou([0,0,10,10],[0,0,10,10]) == 1.0

def test_choose_prefers_closer_and_plausible():
    glimmer = [0,0,100,100]
    frame_area = 100*100
    text_cand = {'box':[0,0,90,90], 'bbox':[0,0,0.09,0.09], 'score':0.6}  # area 0.0081 plausible? 0.0081 >0.001 yes
    box_cand = {'box':[80,80,95,95], 'bbox':[0.8,0.8,0.95,0.95], 'score':0.9}  # iou with glimmer: text 0.81, box 0.0225 -> text closer
    pref, reason = sam.choose_preferred_on_disagreement(text_cand, box_cand, glimmer, frame_area)
    assert pref is text_cand

def test_choose_prefers_plausible_over_implausible():
    glimmer = [0,0,100,100]
    frame_area = 100*100
    # text huge implausible >60%
    text_cand = {'box':[0,0,100,100], 'bbox':[0,0,1.0,1.0], 'score':0.9} # area 1.0 not plausible (>0.6)
    box_cand = {'box':[10,10,50,50], 'bbox':[0.1,0.1,0.5,0.5], 'score':0.6} # area 0.16 plausible
    pref, reason = sam.choose_preferred_on_disagreement(text_cand, box_cand, glimmer, frame_area)
    assert pref is box_cand
    assert reason == 'box_plausible'

def test_is_plausible_area_bounds():
    assert sam.is_plausible_area(0.001) is True
    assert sam.is_plausible_area(0.60) is True
    assert sam.is_plausible_area(0.0005) is False
    assert sam.is_plausible_area(0.61) is False

def test_build_prompts_last_word_fallback():
    prompts = sam.build_generic_prompts("upper metal ring", "ring")
    # should include stripped "ring" or last word
    assert "ring" in prompts

# 8 tests are above (we have 9 actually, but ticket says 8, we provide 8+)
