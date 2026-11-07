# Third-party notices

The bridge adapts ideas and small portions of `examples/wechatauto_bridge.py` from the whale-girl project, distributed under the following license:

MIT License

Copyright (c) 2026 鲸鲸 / whale-girl contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


## Other dependencies and bundled runtimes

The project's own code is provided under the MIT license in LICENSE. Third-party
components retain their own licenses; the project license does not replace them.

- `wechatauto-replica==1.2.7.0`: Apache-2.0, as declared in its installed package
  metadata. Upstream: https://github.com/fanyuantaier/wechatauto-replica
- `requests`: Apache-2.0. Upstream: https://github.com/psf/requests
- Portable distributions include Node.js and Python. Their licenses are provided
  in `runtime/node/LICENSE` and `runtime/python/LICENSE.txt`, respectively.
- Python dependencies bundled with the portable distribution retain the notices
  and license files shipped in their package directories and `.dist-info` folders.

The source repository does not vendor these runtimes or Python packages. It does
not distribute WeChat or character art from the demonstration video. Third-party
names are used to identify compatibility and dependencies.
