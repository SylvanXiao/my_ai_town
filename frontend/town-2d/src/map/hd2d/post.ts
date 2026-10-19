import * as THREE from 'three'

// 后期：移轴景深（画面上下两端按离焦点的距离模糊）与调色暗角。
// 调色在色调映射之前的线性空间里做，对比度以中灰 0.18 为中心按幂次拉开，暗部不会变成负数。

const vertexShader =
  'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}'

/** 移轴的清晰带在画面里的高度（从下往上 0～1）：地图没被面板盖住时稍低于正中 */
export const TILT_FOCUS = 0.48

/** 一个方向的高斯模糊，横竖各跑一遍；amount 是最远处每一采样步的设备像素 */
export const tiltShader = {
  uniforms: {
    tDiffuse: { value: null },
    dir: { value: new THREE.Vector2(1, 0) },
    amount: { value: 2.6 },
    focus: { value: TILT_FOCUS },
    band: { value: 0.16 },
    res: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader,
  fragmentShader: `uniform sampler2D tDiffuse;uniform vec2 dir;uniform float amount;uniform float focus;uniform float band;uniform vec2 res;varying vec2 vUv;
void main(){float r=smoothstep(band,band+0.38,abs(vUv.y-focus))*amount;vec4 c=vec4(0.);float total=0.;
for(int i=-7;i<=7;i++){float w=exp(-float(i*i)/24.);c+=texture2D(tDiffuse,vUv+dir*float(i)*r/res)*w;total+=w;}
gl_FragColor=c/total;}`,
}

export const gradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tint: { value: new THREE.Color(1, 1, 1) },
    sat: { value: 1.18 },
    vignette: { value: 0.55 },
    lift: { value: new THREE.Color(0, 0, 0) },
    contrast: { value: 1 },
  },
  vertexShader,
  fragmentShader: `uniform sampler2D tDiffuse;uniform vec3 tint;uniform float sat;uniform float vignette;uniform vec3 lift;uniform float contrast;varying vec2 vUv;
void main(){vec4 c=texture2D(tDiffuse,vUv);float l=dot(c.rgb,vec3(.2126,.7152,.0722));c.rgb=mix(vec3(l),c.rgb,sat)*tint+lift;c.rgb=.18*pow(max(c.rgb,vec3(0.))/.18,vec3(contrast));
vec2 q=vUv-.5;q.x*=1.25;c.rgb*=mix(1.,smoothstep(.95,.25,length(q)),vignette);gl_FragColor=c;}`,
}
