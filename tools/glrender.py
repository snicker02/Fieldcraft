#!/usr/bin/env python3
"""Render the real sampling shader headlessly and dump the read-back bytes.

Called by tools/validate.mjs. The node side writes job.json plus the exact
shader strings the browser would get; this runs them against real GL through
Mesa/EGL and writes pixels.bin, which node then voxelises and compares against
a CPU oracle. That closes the loop on the parts JavaScript alone cannot check:
the GLSL itself, the tile arithmetic inside the shader, and the readback layout.

Requires moderngl and a working EGL stack:
    pip install moderngl
    apt-get install libegl1 libgl1-mesa-dri
"""

import json
import sys
import os


def main(job_dir):
    import moderngl

    job = json.load(open(os.path.join(job_dir, "job.json")))
    vs = open(os.path.join(job_dir, "shader.vert")).read()
    fs = open(os.path.join(job_dir, "shader.frag")).read()

    ctx = moderngl.create_context(standalone=True, backend="egl", require=330)
    prog = ctx.program(vertex_shader=vs, fragment_shader=fs)

    def put(name, value):
        if name in prog:
            prog[name].value = tuple(value) if isinstance(value, list) else value

    put("fcRes", job["res"])
    put("fcBoxMin", job["boxMin"])
    put("fcBoxMax", job["boxMax"])
    put("fcTilesX", job["tilesX"])
    put("fcIso", job["iso"])
    put("fcNormEps", job["normEps"])
    for u in job["uniforms"]:
        put(u["name"], u["value"])

    w, h = job["atlasW"], job["atlasH"]
    rb = ctx.renderbuffer((w, h), components=4, dtype="f1")
    fbo = ctx.framebuffer(color_attachments=[rb])
    fbo.use()
    ctx.disable(moderngl.DEPTH_TEST | moderngl.BLEND)
    vao = ctx.vertex_array(prog, [])

    out = open(os.path.join(job_dir, "pixels.bin"), "wb")
    for slab in job["slabs"]:
        put("fcSliceBase", slab["zStart"])
        put("fcSliceCount", slab["zCount"])
        fbo.clear(0.0, 0.0, 0.0, 0.0)
        vao.render(moderngl.TRIANGLES, vertices=3)
        out.write(fbo.read(components=4, dtype="f1"))
    out.close()

    print(json.dumps({
        "ok": True,
        "renderer": ctx.info["GL_RENDERER"],
        "version": ctx.info["GL_VERSION"],
        "bytes": w * h * 4 * len(job["slabs"]),
    }))


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except Exception as exc:  # reported as a skip by the node harness
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        sys.exit(2)
