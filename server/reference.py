# Pi 5 official reference pack
REFERENCES = [
    {
        "part": "fan_connector",
        "name": "FAN header",
        "side": "top",
        "description": "4-pin white socket labelled FAN near the USB ports",
        "source_url": "https://www.raspberrypi.com/documentation/computers/raspberry-pi.html"
    },
    {
        "part": "active_cooler_fan",
        "name": "Active cooler fan",
        "side": "top",
        "description": "Fan plugs into FAN header",
        "source_url": "https://www.raspberrypi.com/documentation/computers/raspberry-pi.html"
    },
    {
        "part": "usb_c_power_port",
        "name": "USB-C power J1",
        "side": "top",
        "description": "USB-C power port lower-left",
        "source_url": "https://www.raspberrypi.com/documentation/computers/raspberry-pi.html"
    },
    {
        "part": "micro_hdmi_port",
        "name": "micro-HDMI",
        "side": "top",
        "description": "Two micro-HDMI ports",
        "source_url": "https://www.raspberrypi.com/documentation/computers/raspberry-pi.html"
    },
    {
        "part": "microsd_slot",
        "name": "microSD slot",
        "side": "underside",
        "description": "microSD slot on underside right",
        "source_url": "https://www.raspberrypi.com/documentation/computers/getting-started.html"
    },
]

def get_reference_text():
    lines = []
    for r in REFERENCES:
        lines.append(f"{r['name']} ({r['part']}): {r['description']} side={r['side']} – {r['source_url']}")
    return "\n".join(lines)

def get_part_side(part):
    for r in REFERENCES:
        if r['part'] == part:
            return r['side']
    return None
