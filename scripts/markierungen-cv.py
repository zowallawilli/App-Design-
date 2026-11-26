# Kreuzvalidierung: feste Schwelle vs. logistische Regression mit verschiedenen Merkmalssätzen (braucht numpy).
# python3 scripts/markierungen-cv.py features.json
import json,sys,math,random
import numpy as np
d=json.load(open(sys.argv[1]))
# Doppelte (Abschnittsgrenze) entfernen
seen=set(); D=[]
for x in d:
  k=(x['schwall'],round(x['density'],3),str(x['tex']),x['d'] if x['river']=='inn' else None)
  if k in seen: continue
  seen.add(k); D.append(x)
y=np.array([1 if x['schwall'] else 0 for x in D])
def col(name):
  v=np.array([x[name] if x[name] is not None and x[name]==x[name] else np.nan for x in D],float)
  return v
raw={n:col(n) for n in ['density','smooth','width','whiteFrac','tex','contrast','whiteSat','waterV','edgeFrac','bandFrac','longest','whiteArea','waterTex','whiteWarm']}
for n,v in raw.items():
  m=np.nanmedian(v); raw[n]=np.where(np.isnan(v),m,v)
raw['density']=np.log1p(raw['density']); raw['whiteArea']=np.log1p(raw['whiteArea']); raw['width']=np.log(np.maximum(raw['width'],1)/25)
print('n=',len(D),'Schwall',y.sum())
for n,v in raw.items():
  a,b=v[y==1],v[y==0]
  # Trennschärfe: AUC
  auc=np.mean([(p>q)+0.5*(p==q) for p in a for q in b])
  print(f'  {n:10s} Schwall Median {np.median(a):7.2f}  kein {np.median(b):7.2f}  AUC {auc:.2f}')
fixed=np.array([(x['density']>=5 and x['smooth']>=0.18) for x in D])
print('feste Schwelle:',round((fixed==y).mean()*100),'%')
def fit(X,y,l2=0.05,it=3000,lr=0.2):
  w=np.zeros(X.shape[1]);b=0.0
  wt=np.where(y==1,len(y)/(2*y.sum()),len(y)/(2*(len(y)-y.sum())))
  for _ in range(it):
    p=1/(1+np.exp(-(X@w+b))); e=(p-y)*wt
    w-=lr*(X.T@e/len(y)+l2*w); b-=lr*e.mean()
  return w,b
def cv(names,reps=20):
  X0=np.column_stack([raw[n] for n in names]); acc=[]
  for r in range(reps):
    rng=np.random.default_rng(r); idx=rng.permutation(len(y)); folds=np.array_split(idx,5); ok=0
    for f in folds:
      tr=np.setdiff1d(idx,f); mu=X0[tr].mean(0); sd=X0[tr].std(0)+1e-9
      w,b=fit((X0[tr]-mu)/sd,y[tr]); p=((X0[f]-mu)/sd)@w+b
      ok+=((p>0)==y[f]).sum()
    acc.append(ok/len(y))
  return np.mean(acc)
sets={'alt (Dichte, Anteil, Breite)':['density','smooth','width'],
 'alt + Textur/Kontrast':['density','smooth','width','tex','contrast','whiteSat'],
 'alt + Form (Ufer, Band, Länge)':['density','smooth','width','edgeFrac','bandFrac','longest'],
 'alt + Wasser-Rauheit + Weiß-Farbe':['density','smooth','width','waterTex','whiteWarm'],
 'alle':list(raw)}
for k,v in sets.items(): print(f'{k:32s} {cv(v)*100:.0f} %')
# Vorwärtsauswahl
sel=[];best=0
for step in range(6):
  cand=[(cv(sel+[n],8),n) for n in raw if n not in sel]
  a,n=max(cand)
  if a<=best+0.005: break
  sel.append(n);best=a;print('  +',n,f'{a*100:.0f} %')
print('Auswahl',sel)
# je Fluss


