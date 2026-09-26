
import bpy, math
from mathutils import Vector
for name in ['car_sedan_01', 'Empire executive sedan']:
    obj=bpy.data.objects.get(name)
    if obj: bpy.data.objects.remove(obj, do_unlink=True)
def mat(name, color, metallic=0.0, rough=.4):
    m=bpy.data.materials.new(name); m.diffuse_color=(*color,1)
    m.use_nodes=True; b=m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value=(*color,1); b.inputs['Metallic'].default_value=metallic; b.inputs['Roughness'].default_value=rough
    if metallic>.4: b.inputs['Coat Weight'].default_value=.7
    return m
paint=mat('Midnight graphite metallic',(.026,.065,.076),.76,.22)
glass=mat('Smoked panoramic glass',(.027,.047,.057),.35,.12)
chrome=mat('Satin aluminium',(.55,.6,.61),.93,.24)
rubber=mat('Rubber sidewall',(.012,.014,.015),0,.83)
dark=mat('Grille black',(.016,.021,.023),.4,.4)
white=mat('LED pearl',(.9,.93,1),.3,.2)
red=mat('Tail lamp',(.4,.008,.009),.3,.18)
root=bpy.data.objects.new('Executive_Sedan',None);bpy.context.collection.objects.link(root)
def cube(name,loc,dim,material,bevel=.02,parent=root):
    bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.name=name;o.dimensions=dim
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    o.data.materials.append(material)
    if bevel:
        mod=o.modifiers.new('Manufactured edge radius','BEVEL');mod.width=bevel;mod.segments=3
        o.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
    o.parent=parent;return o
def loft(name,stations,material):
    verts=[];faces=[];n=16
    for y,w,bottom,top in stations:
        for i in range(n):
            a=2*math.pi*i/n
            x=w*math.copysign(abs(math.cos(a))**.32, math.cos(a))
            z=(bottom+top)/2+(top-bottom)/2*math.copysign(abs(math.sin(a))**.44,math.sin(a))
            verts.append((x,y,z))
    for j in range(len(stations)-1):
        for i in range(n):
            a=j*n+i; b=j*n+(i+1)%n;faces.append((a,b,b+n,a+n))
    faces.append(tuple(range(n-1,-1,-1)));faces.append(tuple((len(stations)-1)*n+i for i in range(n)))
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.update()
    o=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(o);o.data.materials.append(material);o.parent=root
    for f in o.data.polygons:f.use_smooth=True
    mod=o.modifiers.new('Sculpted body surface','SUBSURF');mod.levels=2
    return o
loft('Sculpted aluminium body',[(-2.35,.67,.44,.7),(-2.2,.87,.35,.83),(-1.7,.92,.33,.94),(-.8,.94,.34,1.03),(.6,.93,.35,1.02),(1.5,.9,.35,.9),(2.1,.84,.38,.76),(2.32,.7,.48,.67)],paint)
loft('Glazed cabin',[(-1.3,.68,.94,1.04),(-.85,.73,.94,1.43),(-.3,.72,.95,1.56),(.45,.68,.94,1.51),(1.18,.64,.95,1.03)],glass)
loft('Floating roof',[(-.92,.66,1.40,1.44),(-.4,.7,1.54,1.58),(.4,.65,1.49,1.53),(.6,.61,1.4,1.44)],paint)
for side in [-1,1]:
    for y in [-1.45,1.45]:
        bpy.ops.mesh.primitive_torus_add(major_radius=.28,minor_radius=.09,major_segments=64,minor_segments=16,location=(side*.9,y,.37),rotation=(0,math.pi/2,0))
        o=bpy.context.object;o.name='Tire';o.data.materials.append(rubber);o.parent=root
        for f in o.data.polygons:f.use_smooth=True
        bpy.ops.mesh.primitive_cylinder_add(vertices=48,radius=.235,depth=.055,location=(side*.995,y,.37),rotation=(0,math.pi/2,0))
        o=bpy.context.object;o.name='Alloy wheel';o.data.materials.append(dark);o.parent=root
        for k in range(10):
            a=k*math.pi/5
            spoke=cube('Machined spoke',(side*1.027,y+math.sin(a)*.115,.37+math.cos(a)*.115),(.018,.025,.22),chrome,.006)
            spoke.rotation_euler.x=-a
        for k in range(5):
            a=k*math.pi*.4
            cube('Wheel bolt',(side*1.04,y+math.sin(a)*.045,.37+math.cos(a)*.045),(.012,.015,.015),chrome,.005)
    cube('Sill brightwork',(side*.922,0,.42),(.028,2.5,.045),chrome,.01)
    cube('Flush door handle',(side*.92,-.55,.94),(.028,.21,.035),chrome,.012)
    cube('Flush door handle',(side*.92,.6,.94),(.028,.21,.035),chrome,.012)
    cube('B pillar',(side*.716,-.05,1.22),(.05,.1,.48),paint,.015)
    mirror=cube('Wing mirror',(side*1.02,.89,1.09),(.22,.29,.13),paint,.06)
    cube('Mirror lens',(side*1.024,.735,1.10),(.18,.017,.083),chrome,.015)
    cube('LED headlight',(side*.58,2.21,.71),(.4,.06,.07),white,.028)
    cube('Red tail light',(side*.59,-2.24,.76),(.45,.04,.07),red,.025)
cube('Front lower intake',(0,2.28,.51),(1.24,.04,.18),dark,.025)
for i in range(13):cube('Intake blade',(-.55+i*.091,2.306,.51),(.015,.02,.14),chrome,.004)
cube('Rear licence plate',(0,-2.33,.61),(.43,.014,.11),chrome,.01)
cube('Rear diffuser',(0,-2.29,.39),(1.2,.08,.1),dark,.02)
ground=mat('Studio concrete',(.21,.23,.23),0,.9)
cube('Preview_ground',(0,0,-.06),(200,200,.1),ground,0,parent=None)
world=bpy.context.scene.world or bpy.data.worlds.new('World');bpy.context.scene.world=world
world.use_nodes=True;world.node_tree.nodes['Background'].inputs[0].default_value=(.3,.38,.45,1);world.node_tree.nodes['Background'].inputs[1].default_value=.45
def light(name,kind,loc,energy,color):
    data=bpy.data.lights.new(name,kind);data.energy=energy;data.color=color
    o=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(o);o.location=loc;o.rotation_euler=(Vector((0,0,.6))-o.location).to_track_quat('-Z','Y').to_euler()
    if kind=='AREA':data.shape='DISK';data.size=5
light('Key softbox','AREA',(4,4,7),1400,(1,.88,.7))
light('Cool fill','AREA',(-4,1,4),1000,(.64,.79,1))
light('Rim','AREA',(0,-5,5),1600,(1,1,1))
data=bpy.data.cameras.new('DeliveryCamera');cam=bpy.data.objects.new('DeliveryCamera',data);bpy.context.collection.objects.link(cam)
cam.location=(6.5,8,4.0);cam.rotation_euler=(Vector((0,0,.7))-cam.location).to_track_quat('-Z','Y').to_euler();data.lens=52
scene=bpy.context.scene;scene.camera=cam;scene.render.engine='BLENDER_EEVEE';scene.render.resolution_x=1000;scene.render.resolution_y=680;scene.render.resolution_percentage=100
scene.render.image_settings.media_type='IMAGE';scene.render.image_settings.file_format='PNG'
if 'artifacts' in globals():
    target=artifacts.file(name='executive-sedan-preview.png',media_type='image/png')
    scene.render.filepath=str(target.path);bpy.ops.render.render(write_still=True);target.publish()
else:
    from pathlib import Path
    output=Path(__file__).resolve().parents[1]/'artifacts'
    output.mkdir(exist_ok=True)
    scene.render.filepath=str(output/'executive-sedan-preview.png')
    bpy.ops.render.render(write_still=True)
    bpy.ops.object.select_all(action='DESELECT')
    root.select_set(True)
    for child in root.children_recursive: child.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(output/'executive-sedan.glb'),use_selection=True)
result={'asset':'Executive_Sedan','dimensions_metres':[2.1,4.7,1.58],'preview':'executive-sedan-preview.png'}
