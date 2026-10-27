# Pi 5 official reference pack
REFERENCES = [
    {
        "part": "fan_connector",
        "name": "FAN header",
        "side": "top",
        "description": "4-pin white socket labelled FAN near the USB ports",
        "visual": "small white 4-pin JST socket labelled FAN at the top edge just left of the silver USB stack",
        "source_url": "https://www.raspberrypi.com/documentation/computers/raspberry-pi.html"
    },
    {
        "part": "active_cooler_fan",
        "name": "Active cooler fan",
        "side": "top",
        "description": "Fan plugs into FAN header",
        "visual": "the fan on the heatsink",
        "source_url": "https://www.raspberrypi.com/documentation/computers/raspberry-pi.html"
    },
    {
        "part": "usb_c_power_port",
        "name": "USB-C power J1",
        "side": "top",
        "description": "USB-C power port lower-left",
        "visual": "silver USB-C connector at the bottom-left corner labelled J1/PWR",
        "source_url": "https://www.raspberrypi.com/documentation/computers/raspberry-pi.html"
    },
    {
        "part": "micro_hdmi_port",
        "name": "micro-HDMI",
        "side": "top",
        "description": "Two micro-HDMI ports",
        "visual": "two silver ports on the bottom edge, HDMI0 left and HDMI1 right",
        "source_url": "https://www.raspberrypi.com/documentation/computers/raspberry-pi.html"
    },
    {
        "part": "microsd_slot",
        "name": "microSD slot",
        "side": "underside",
        "description": "microSD slot on underside right",
        "visual": "brown push-push holder at the right edge of the UNDERSIDE",
        "source_url": "https://www.raspberrypi.com/documentation/computers/getting-started.html"
    },
]

def get_reference_text():
    lines = []
    for r in REFERENCES:
        vis = r.get('visual','')
        vis_str = f" visual={vis}" if vis else ''
        lines.append(f"{r['name']} ({r['part']}): {r['description']} side={r['side']}{vis_str} – {r['source_url']}")
    return "\n".join(lines)

def get_part_side(part):
    for r in REFERENCES:
        if r['part'] == part:
            return r['side']
    return None

def get_part_label(part):
    for r in REFERENCES:
        if r['part'] == part:
            return r['name']
    return part

def get_part_visual(part):
    for r in REFERENCES:
        if r['part'] == part:
            return r.get('visual','')
    return ''
