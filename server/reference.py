# Pi 5 official reference pack
REFERENCES = [
    {
        "part": "fan_connector",
        "name": "FAN header",
        "location": "top, near USB ports",
        "source": "https://www.raspberrypi.com/documentation/computers/raspberry-pi.html"
    },
    {
        "part": "usb_c_power_port",
        "name": "USB-C power J1",
        "location": "top, lower-left",
        "source": "https://www.raspberrypi.com/documentation/computers/raspberry-pi.html"
    },
    {
        "part": "micro_hdmi_port",
        "name": "micro-HDMI",
        "location": "top",
        "source": "https://www.raspberrypi.com/documentation/computers/raspberry-pi.html"
    },
    {
        "part": "microsd_slot",
        "name": "microSD slot",
        "location": "underside right",
        "source": "https://www.raspberrypi.com/documentation/computers/getting-started.html"
    },
]

def get_reference_text():
    lines = []
    for r in REFERENCES:
        lines.append(f"{r['name']} ({r['part']}): {r['location']} – {r['source']}")
    return "\n".join(lines)
