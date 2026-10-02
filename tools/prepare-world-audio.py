"""Prepare licensed recordings downloaded into /tmp/empire-audio-source.
Source links, authors and licenses are in public/audio/README.md. Requires ffmpeg.
The shipped WAVs are mono PCM16/24kHz: short, browser-compatible and locally served.
"""
from pathlib import Path
import subprocess,array,wave,math
SRC=Path('/tmp/empire-audio-source')
OUT=Path(__file__).resolve().parents[1]/'src/client/public/audio';OUT.mkdir(exist_ok=True)
def convert(source,name,start=0,duration=None,loop=False,filters='',rms=.12):
    cmd=['ffmpeg','-v','error','-ss',str(start),'-i',str(source)]
    if duration:cmd+=['-t',str(duration)]
    if filters:cmd+=['-af',filters]
    cmd+=['-ar','24000','-ac','1','-f','s16le','-']
    a=array.array('h',subprocess.check_output(cmd));f=[v/32768 for v in a]
    mean=sum(f)/len(f);f=[v-mean for v in f]
    gain=min(rms/max(.00001,(sum(v*v for v in f)/len(f))**.5),.86/max(abs(v) for v in f))
    f=[v*gain for v in f]
    if loop:
        # Crossfade the end into the head, then remove the overlapped head. Boundary stays continuous.
        n=2400
        for i in range(n):
            u=i/(n-1);f[-n+i]=f[-n+i]*(1-u)+f[i]*u
        f=f[n:]
    else:
        n=min(120,len(f)//3)
        for i in range(n):f[i]*=i/n;f[-1-i]*=i/n
    with wave.open(str(OUT/(name+'.wav')),'wb') as w:
        w.setparams((1,2,24000,0,'NONE','not compressed'));w.writeframes(array.array('h',[int(v*32767) for v in f]).tobytes())
for surface in ['wood','concrete','grass','carpet']:
    for i in range(5):
        convert(SRC/f'kenney/Audio/footstep_{surface}_{i:03}.ogg',f'step-{surface}-{i}',filters='silenceremove=start_periods=1:start_threshold=-48dB',rms=.14)
convert(SRC/'idle.mp3','engine-idle',.2,7.8,True,'highpass=f=45,lowpass=f=4200',.16)
convert(SRC/'road.mp3','engine-load',19,4.6,True,'highpass=f=55,lowpass=f=650',.13)
convert(SRC/'road.mp3','road-roll',32,6.6,True,'highpass=f=900,lowpass=f=6500',.12)
convert(SRC/'start.mp3','engine-start',0,1.65,False,'lowpass=f=4200',.17)
convert(SRC/'road.mp3','engine-stop',63.4,1.3,False,'highpass=f=45,lowpass=f=2600',.1)
for n in ['open','close']:
    convert(SRC/f'door-{n}.wav',f'door-{n}',filters='silenceremove=start_periods=1:start_threshold=-42dB',rms=.2)
print('Prepared',len(list(OUT.glob('*.wav'))),'recordings')
