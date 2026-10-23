import zipfile, re

pptx_path = r'C:\Users\y\OneDrive\Desktop\挑战杯\复赛\书生挑战杯数学智能体_可编辑PPT封面.pptx'
with zipfile.ZipFile(pptx_path, 'r') as z:
    for name in z.namelist():
        if 'theme' in name or 'slide1' in name:
            data = z.read(name).decode('utf-8', errors='ignore')
            colors = set(re.findall(r'srgbClr val="([0-9A-Fa-f]{6})"', data))
            print(name, 'colors:', colors)
        if 'media/' in name:
            print('Media:', name)
