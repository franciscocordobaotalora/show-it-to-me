import os, json, base64

def main():
    from glimmer import pass1
    from reference import get_reference_text
    path = 'app/fixtures/pi5/Raspberry_Pi_5_Board.jpg'
    try:
        with open(path,'rb') as f:
            b64 = base64.b64encode(f.read()).decode()
    except:
        print(json.dumps({'error':'fixture missing'}))
        return
    data_url = 'data:image/jpeg;base64,'+b64
    ref = get_reference_text()
    result = pass1(data_url, 'Where does the fan plug in?', ref)
    print(json.dumps(result, indent=2))

if __name__ == '__main__':
    main()
