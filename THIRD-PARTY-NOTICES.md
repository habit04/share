# Third-party notices

JCad Electrical is free software, licensed under the **GNU General Public License,
version 3 only** (SPDX `GPL-3.0-only`). The full licence text is in [LICENSE](LICENSE).
This file lists the third-party software and data that JCad Electrical uses or ships, with
their licences, copyright holders and, where a licence requires the notice to travel with
copies, the full licence text.

JCad Electrical is an independent project. It is not affiliated with, endorsed by or
sponsored by Autodesk, Inc. "AutoCAD" and "DWG" are mentioned only to describe file
compatibility. All artwork, icons and symbol geometry in JCad Electrical are original.

## What the installers contain

The Windows installer (`.exe`, NSIS), the macOS disk images (`.dmg`, Apple Silicon and
Intel) and the Linux `.AppImage` / `.deb` packages contain:

- the **Electron** runtime (which includes Chromium, Node.js, V8, FFmpeg and the other
  components Electron is built from) - see [Electron and Chromium](#electron-and-chromium);
- the application code of JCad Electrical (GPL-3.0-only);
- the **LibreDWG** WebAssembly build from `@mlightcad/libredwg-web`, used to read DWG files
  (GPL-3.0) - see [LibreDWG](#libredwg-via-mlightcadlibredwg-web);
- `electron-updater` and its dependencies, used for update checks;
- the `hershey` package and the **Hershey Roman Simplex** font data
  (`src/render/fonts/rowmans.jhf`, compiled into the renderer bundle) - see
  [Hershey fonts](#hershey-fonts).

The browser edition on the project website contains the same renderer code, the Hershey
font data and the LibreDWG WebAssembly build (loaded the first time a DWG file is opened).
It does not contain Electron or electron-updater.

The corresponding source code for everything JCad Electrical itself distributes is the
repository at <https://github.com/habit04/share>, at the commit tagged for the release
(for example `v0.3.4`). The source of LibreDWG is at
<https://www.gnu.org/software/libredwg/> and of its WebAssembly wrapper at
<https://github.com/mlightcad/libredwg-web>.

## Summary

### Runtime dependencies (shipped in the installers)

Versions are the ones in `package-lock.json` at the time this file was written.

| Package | Version | Licence | Copyright | Used by | Link |
| --- | --- | --- | --- | --- | --- |
| @mlightcad/libredwg-web | 0.7.14 | GPL-3.0 | MLight Lee (JavaScript/TypeScript wrapper); GNU LibreDWG: Free Software Foundation, Inc. | direct dependency | <https://github.com/mlightcad/libredwg-web> |
| electron-updater | 6.8.9 | MIT | Copyright (c) 2015 Loopline Systems | direct dependency | <https://github.com/electron-userland/electron-builder> |
| hershey | 2.1.7 | MIT (code); Hershey font data under the Hershey use restriction | Copyright (c) 2019 Ben Nortier | direct dependency | <https://github.com/bjnortier/hershey> |
| builder-util-runtime | 9.7.0 | MIT | Copyright (c) 2015 Loopline Systems | electron-updater | <https://github.com/electron-userland/electron-builder> |
| fs-extra | 10.1.0 | MIT | Copyright (c) 2011-2017 JP Richardson | electron-updater | <https://github.com/jprichardson/node-fs-extra> |
| jsonfile | 6.2.1 | MIT | Copyright (c) 2012-2015, JP Richardson | fs-extra | <https://github.com/jprichardson/node-jsonfile> |
| universalify | 2.0.1 | MIT | Copyright (c) 2017, Ryan Zimmerman | fs-extra | <https://github.com/RyanZim/universalify> |
| graceful-fs | 4.2.11 | ISC | Copyright (c) 2011-2022 Isaac Z. Schlueter, Ben Noordhuis, and Contributors | fs-extra | <https://github.com/isaacs/node-graceful-fs> |
| js-yaml | 4.3.2 | MIT | Copyright (C) 2011-2015 by Vitaly Puzrin | electron-updater | <https://github.com/nodeca/js-yaml> |
| argparse | 2.0.1 | Python-2.0 | Copyright (c) 2001-2020 Python Software Foundation (see the licence text) | js-yaml | <https://github.com/nodeca/argparse> |
| lazy-val | 1.0.5 | MIT | Vladimir Krivosheev (package author; the package ships no licence file) | electron-updater | <https://github.com/develar/lazy-val> |
| lodash.escaperegexp | 4.1.2 | MIT | Copyright jQuery Foundation and other contributors | electron-updater | <https://lodash.com/> |
| lodash.isequal | 4.5.0 | MIT | Copyright JS Foundation and other contributors | electron-updater | <https://lodash.com/> |
| semver | 7.7.4 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors | electron-updater | <https://github.com/npm/node-semver> |
| tiny-typed-emitter | 2.1.0 | MIT | Copyright (c) 2020 Zurab Benashvili (binier) | electron-updater | <https://github.com/binier/tiny-typed-emitter> |
| debug | 4.4.3 | MIT | Copyright (c) 2014-2017 TJ Holowaychuk; Copyright (c) 2018-2021 Josh Junon | builder-util-runtime | <https://github.com/debug-js/debug> |
| ms | 2.1.3 | MIT | Copyright (c) 2020 Vercel, Inc. | debug | <https://github.com/vercel/ms> |
| sax | 1.6.1 | BlueOak-1.0.0 | Isaac Z. Schlueter and contributors | builder-util-runtime | <https://github.com/isaacs/sax-js> |
| Hershey font data (`rowmans.jhf`) | - | Public domain, with the Hershey use restriction | Dr. A. V. Hershey (U.S. National Bureau of Standards); data format by James Hurt, Cognition, Inc. | text rendering | [notice](#hershey-fonts) |
| Electron runtime (Chromium, Node.js, ...) | 33.4.11 | MIT (Electron); various (components) | Electron contributors; GitHub Inc.; The Chromium Authors; others | the whole app | <https://github.com/electron/electron> |

### Development dependencies (build and test only)

These are used to build, test and package JCad Electrical. Apart from the Electron runtime,
the NSIS installer stub of electron-builder and a few lines of Vite's module-preload helper,
none of their code is part of what is distributed.

| Package | Version | Licence | Copyright | Role | Link |
| --- | --- | --- | --- | --- | --- |
| electron | 33.4.11 | MIT | Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc. | Runtime shipped inside every installer (see below). | <https://github.com/electron/electron> |
| electron-builder | 26.15.3 | MIT | Copyright (c) 2015 Loopline Systems | Build tool; its NSIS installer stub is part of the Windows installer. | <https://github.com/electron-userland/electron-builder> |
| vite | 6.4.3 | MIT | Copyright (c) 2019-present, VoidZero Inc. and Vite contributors | Build tool; small Vite runtime helpers (module preload) end up in the renderer bundle. | <https://github.com/vitejs/vite> |
| typescript | 5.9.3 | Apache-2.0 | Copyright (c) Microsoft Corporation | Compiler only. | <https://github.com/microsoft/TypeScript> |
| vitest | 2.1.9 | MIT | Copyright (c) 2021-Present Vitest Team | Unit tests only. | <https://github.com/vitest-dev/vitest> |
| playwright | 1.63.0 | Apache-2.0 | Copyright (c) Microsoft Corporation | Screenshot and website checks only. | <https://github.com/microsoft/playwright> |
| @types/node | 22.20.4 | MIT | Copyright (c) Microsoft Corporation | Type definitions only. | <https://github.com/DefinitelyTyped/DefinitelyTyped> |
| concurrently | 9.2.4 | MIT | Copyright (c) 2015 Kimmo Brunfeldt | Development script runner only. | <https://github.com/open-cli-tools/concurrently> |
| cross-env | 7.0.3 | MIT | Copyright (c) 2017 Kent C. Dodds | Development script runner only. | <https://github.com/kentcdodds/cross-env> |
| wait-on | 8.0.5 | MIT | Copyright (c) 2015 Jeff Barczewski | Development script runner only. | <https://github.com/jeffbski/wait-on> |

### Other material in the repository

| Material | Origin | Licence |
| --- | --- | --- |
| `fixtures/example_*.dwg`, `fixtures/example_2000.dxf` | Sample drawings from the GNU LibreDWG test suite, used by the unit tests only (not in the installers) | Distributed with GNU LibreDWG, GPL-3.0-or-later |
| `src/render/fonts/rowmans.jhf` | Hershey Roman Simplex, identical to `font/jhf/rowmans.jhf` of the `hershey` package | Public domain with the [Hershey use restriction](#hershey-fonts) |
| `src/render/fonts/HERSHEY-LICENSE` | The notice that accompanied the Usenet distribution of the Hershey fonts | Reproduced as required |
| Symbol libraries, icons, parts catalog (`src/electrical/catalog.json`) | Original to JCad Electrical; catalog parts are invented | GPL-3.0-only |

## LibreDWG (via @mlightcad/libredwg-web)

JCad Electrical reads DWG files with **GNU LibreDWG** compiled to WebAssembly by the
`@mlightcad/libredwg-web` package (version 0.7.14, `"license": "GPL-3.0"` in its
`package.json`; the package itself ships no separate licence file).

- GNU LibreDWG: Copyright (C) Free Software Foundation, Inc. Licensed under the GNU General
  Public License, version 3 or (at your option) any later version.
  <https://www.gnu.org/software/libredwg/>
- libredwg-web (JavaScript/TypeScript wrapper and build): Copyright MLight Lee.
  Licensed under GPL-3.0. <https://github.com/mlightcad/libredwg-web>
- The WebAssembly module includes runtime code generated by Emscripten, which is available
  under the MIT licence or the University of Illinois/NCSA Open Source License
  (<https://github.com/emscripten-core/emscripten/blob/main/LICENSE>).

Because LibreDWG is licensed under the GPL, JCad Electrical as distributed (with LibreDWG
inside) is licensed under the GNU GPL version 3; the full text of that licence is in
[LICENSE](LICENSE), which applies to LibreDWG as distributed here as well.

## Hershey fonts

TEXT and MTEXT are drawn with the Hershey **Roman Simplex** single-stroke font
(`src/render/fonts/rowmans.jhf`, the same file as `font/jhf/rowmans.jhf` in the `hershey`
npm package). The Hershey font data is in the public domain, subject to the use restriction
below, whose acknowledgements must be distributed with the font data. The complete notice
that accompanied the original distribution is in
[src/render/fonts/HERSHEY-LICENSE](src/render/fonts/HERSHEY-LICENSE); the required part is
reproduced here:

```text
USE RESTRICTION:
	This distribution of the Hershey Fonts may be used by anyone for
	any purpose, commercial or otherwise, providing that:
		1. The following acknowledgements must be distributed with
			the font data:
			- The Hershey Fonts were originally created by Dr.
				A. V. Hershey while working at the U. S.
				National Bureau of Standards.
			- The format of the Font data in this distribution
				was originally created by
					James Hurt
					Cognition, Inc.
					900 Technology Park Drive
					Billerica, MA 01821
					(mit-eddie!ci-dandelion!hurt)
		2. The font data in this distribution may be converted into
			any other format *EXCEPT* the format distributed by
			the U.S. NTIS (which organization holds the rights
			to the distribution and use of the font data in that
			particular format). Not that anybody would really
			*want* to use their format... each point is described
			in eight bytes as "xxx yyy:", where xxx and yyy are
			the coordinate values as ASCII numbers.
```

The JavaScript code of the `hershey` package is MIT-licensed (text below).

## Electron and Chromium

Every installer contains the Electron runtime (version 33.4.11). Electron is MIT-licensed
(text below). Electron is built on Chromium, Node.js, V8 and many other open-source
components under their own licences (BSD-3-Clause, MIT, Apache-2.0, LGPL-2.1 for FFmpeg,
and others). Electron distributes their notices in the file **`LICENSES.chromium.html`**,
which accompanies the Electron runtime and is included in every Electron release archive at
<https://github.com/electron/electron/releases/tag/v33.4.11>. Node.js licence:
<https://github.com/nodejs/node/blob/main/LICENSE>.

## Licence texts

The following texts are reproduced as their licences require for copies that are
distributed (all runtime dependencies above, Electron, and the part of Vite that ends up in
the bundle). Development-only packages under the Apache License 2.0 (TypeScript,
Playwright) are not distributed and are listed above for information; their licence is at
<https://www.apache.org/licenses/LICENSE-2.0>.

### electron-updater 6.8.9

MIT - Copyright (c) 2015 Loopline Systems - <https://github.com/electron-userland/electron-builder>

```text
The MIT License (MIT)

Copyright (c) 2015 Loopline Systems

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
```

### hershey 2.1.7

MIT (code); Hershey font data under the Hershey use restriction - Copyright (c) 2019 Ben Nortier - <https://github.com/bjnortier/hershey>

```text
USE RESTRICTION:
  This distribution of the Hershey Fonts may be used by anyone for
  any purpose, commercial or otherwise, providing that:
    1. The following acknowledgements must be distributed with
      the font data:
      - The Hershey Fonts were originally created by Dr.
      A. V. Hershey while working at the U. S.
      National Bureau of Standards.
      - The format of the Font data in this distribution
        was originally created by
          James Hurt
          Cognition, Inc.
          900 Technology Park Drive
          Billerica, MA 01821
          (mit-eddie!ci-dandelion!hurt)
    2. The font data in this distribution may be converted into
      any other format *EXCEPT* the format distributed by
      the U.S. NTIS (which organization holds the rights
      to the distribution and use of the font data in that
      particular format). Not that anybody would really
      *want* to use their format... each point is described
      in eight bytes as "xxx yyy:", where xxx and yyy are
      the coordinate values as ASCII numbers.

The MIT License (MIT)

Copyright (c) 2019 Ben Nortier

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
```

### builder-util-runtime 9.7.0

MIT - Copyright (c) 2015 Loopline Systems - <https://github.com/electron-userland/electron-builder>

```text
The MIT License (MIT)

Copyright (c) 2015 Loopline Systems

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
```

### fs-extra 10.1.0

MIT - Copyright (c) 2011-2017 JP Richardson - <https://github.com/jprichardson/node-fs-extra>

```text
(The MIT License)

Copyright (c) 2011-2017 JP Richardson

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files
(the 'Software'), to deal in the Software without restriction, including without limitation the rights to use, copy, modify,
 merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS
OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
 ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### jsonfile 6.2.1

MIT - Copyright (c) 2012-2015, JP Richardson - <https://github.com/jprichardson/node-jsonfile>

```text
(The MIT License)

Copyright (c) 2012-2015, JP Richardson <jprichardson@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files
(the 'Software'), to deal in the Software without restriction, including without limitation the rights to use, copy, modify,
 merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS
OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
 ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### universalify 2.0.1

MIT - Copyright (c) 2017, Ryan Zimmerman - <https://github.com/RyanZim/universalify>

```text
(The MIT License)

Copyright (c) 2017, Ryan Zimmerman <opensrc@ryanzim.com>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the 'Software'), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### graceful-fs 4.2.11

ISC - Copyright (c) 2011-2022 Isaac Z. Schlueter, Ben Noordhuis, and Contributors - <https://github.com/isaacs/node-graceful-fs>

```text
The ISC License

Copyright (c) 2011-2022 Isaac Z. Schlueter, Ben Noordhuis, and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### js-yaml 4.3.2

MIT - Copyright (C) 2011-2015 by Vitaly Puzrin - <https://github.com/nodeca/js-yaml>

```text
(The MIT License)

Copyright (C) 2011-2015 by Vitaly Puzrin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### argparse 2.0.1

Python-2.0 - Copyright (c) 2001-2020 Python Software Foundation (see the licence text) - <https://github.com/nodeca/argparse>

```text
A. HISTORY OF THE SOFTWARE
==========================

Python was created in the early 1990s by Guido van Rossum at Stichting
Mathematisch Centrum (CWI, see http://www.cwi.nl) in the Netherlands
as a successor of a language called ABC.  Guido remains Python's
principal author, although it includes many contributions from others.

In 1995, Guido continued his work on Python at the Corporation for
National Research Initiatives (CNRI, see http://www.cnri.reston.va.us)
in Reston, Virginia where he released several versions of the
software.

In May 2000, Guido and the Python core development team moved to
BeOpen.com to form the BeOpen PythonLabs team.  In October of the same
year, the PythonLabs team moved to Digital Creations, which became
Zope Corporation.  In 2001, the Python Software Foundation (PSF, see
https://www.python.org/psf/) was formed, a non-profit organization
created specifically to own Python-related Intellectual Property.
Zope Corporation was a sponsoring member of the PSF.

All Python releases are Open Source (see http://www.opensource.org for
the Open Source Definition).  Historically, most, but not all, Python
releases have also been GPL-compatible; the table below summarizes
the various releases.

    Release         Derived     Year        Owner       GPL-
                    from                                compatible? (1)

    0.9.0 thru 1.2              1991-1995   CWI         yes
    1.3 thru 1.5.2  1.2         1995-1999   CNRI        yes
    1.6             1.5.2       2000        CNRI        no
    2.0             1.6         2000        BeOpen.com  no
    1.6.1           1.6         2001        CNRI        yes (2)
    2.1             2.0+1.6.1   2001        PSF         no
    2.0.1           2.0+1.6.1   2001        PSF         yes
    2.1.1           2.1+2.0.1   2001        PSF         yes
    2.1.2           2.1.1       2002        PSF         yes
    2.1.3           2.1.2       2002        PSF         yes
    2.2 and above   2.1.1       2001-now    PSF         yes

Footnotes:

(1) GPL-compatible doesn't mean that we're distributing Python under
    the GPL.  All Python licenses, unlike the GPL, let you distribute
    a modified version without making your changes open source.  The
    GPL-compatible licenses make it possible to combine Python with
    other software that is released under the GPL; the others don't.

(2) According to Richard Stallman, 1.6.1 is not GPL-compatible,
    because its license has a choice of law clause.  According to
    CNRI, however, Stallman's lawyer has told CNRI's lawyer that 1.6.1
    is "not incompatible" with the GPL.

Thanks to the many outside volunteers who have worked under Guido's
direction to make these releases possible.


B. TERMS AND CONDITIONS FOR ACCESSING OR OTHERWISE USING PYTHON
===============================================================

PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2
--------------------------------------------

1. This LICENSE AGREEMENT is between the Python Software Foundation
("PSF"), and the Individual or Organization ("Licensee") accessing and
otherwise using this software ("Python") in source or binary form and
its associated documentation.

2. Subject to the terms and conditions of this License Agreement, PSF hereby
grants Licensee a nonexclusive, royalty-free, world-wide license to reproduce,
analyze, test, perform and/or display publicly, prepare derivative works,
distribute, and otherwise use Python alone or in any derivative version,
provided, however, that PSF's License Agreement and PSF's notice of copyright,
i.e., "Copyright (c) 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010,
2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020 Python Software Foundation;
All Rights Reserved" are retained in Python alone or in any derivative version
prepared by Licensee.

3. In the event Licensee prepares a derivative work that is based on
or incorporates Python or any part thereof, and wants to make
the derivative work available to others as provided herein, then
Licensee hereby agrees to include in any such work a brief summary of
the changes made to Python.

4. PSF is making Python available to Licensee on an "AS IS"
basis.  PSF MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
IMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, PSF MAKES NO AND
DISCLAIMS ANY REPRESENTATION OR WARRANTY OF MERCHANTABILITY OR FITNESS
FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF PYTHON WILL NOT
INFRINGE ANY THIRD PARTY RIGHTS.

5. PSF SHALL NOT BE LIABLE TO LICENSEE OR ANY OTHER USERS OF PYTHON
FOR ANY INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES OR LOSS AS
A RESULT OF MODIFYING, DISTRIBUTING, OR OTHERWISE USING PYTHON,
OR ANY DERIVATIVE THEREOF, EVEN IF ADVISED OF THE POSSIBILITY THEREOF.

6. This License Agreement will automatically terminate upon a material
breach of its terms and conditions.

7. Nothing in this License Agreement shall be deemed to create any
relationship of agency, partnership, or joint venture between PSF and
Licensee.  This License Agreement does not grant permission to use PSF
trademarks or trade name in a trademark sense to endorse or promote
products or services of Licensee, or any third party.

8. By copying, installing or otherwise using Python, Licensee
agrees to be bound by the terms and conditions of this License
Agreement.


BEOPEN.COM LICENSE AGREEMENT FOR PYTHON 2.0
-------------------------------------------

BEOPEN PYTHON OPEN SOURCE LICENSE AGREEMENT VERSION 1

1. This LICENSE AGREEMENT is between BeOpen.com ("BeOpen"), having an
office at 160 Saratoga Avenue, Santa Clara, CA 95051, and the
Individual or Organization ("Licensee") accessing and otherwise using
this software in source or binary form and its associated
documentation ("the Software").

2. Subject to the terms and conditions of this BeOpen Python License
Agreement, BeOpen hereby grants Licensee a non-exclusive,
royalty-free, world-wide license to reproduce, analyze, test, perform
and/or display publicly, prepare derivative works, distribute, and
otherwise use the Software alone or in any derivative version,
provided, however, that the BeOpen Python License is retained in the
Software, alone or in any derivative version prepared by Licensee.

3. BeOpen is making the Software available to Licensee on an "AS IS"
basis.  BEOPEN MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
IMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, BEOPEN MAKES NO AND
DISCLAIMS ANY REPRESENTATION OR WARRANTY OF MERCHANTABILITY OR FITNESS
FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF THE SOFTWARE WILL NOT
INFRINGE ANY THIRD PARTY RIGHTS.

4. BEOPEN SHALL NOT BE LIABLE TO LICENSEE OR ANY OTHER USERS OF THE
SOFTWARE FOR ANY INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES OR LOSS
AS A RESULT OF USING, MODIFYING OR DISTRIBUTING THE SOFTWARE, OR ANY
DERIVATIVE THEREOF, EVEN IF ADVISED OF THE POSSIBILITY THEREOF.

5. This License Agreement will automatically terminate upon a material
breach of its terms and conditions.

6. This License Agreement shall be governed by and interpreted in all
respects by the law of the State of California, excluding conflict of
law provisions.  Nothing in this License Agreement shall be deemed to
create any relationship of agency, partnership, or joint venture
between BeOpen and Licensee.  This License Agreement does not grant
permission to use BeOpen trademarks or trade names in a trademark
sense to endorse or promote products or services of Licensee, or any
third party.  As an exception, the "BeOpen Python" logos available at
http://www.pythonlabs.com/logos.html may be used according to the
permissions granted on that web page.

7. By copying, installing or otherwise using the software, Licensee
agrees to be bound by the terms and conditions of this License
Agreement.


CNRI LICENSE AGREEMENT FOR PYTHON 1.6.1
---------------------------------------

1. This LICENSE AGREEMENT is between the Corporation for National
Research Initiatives, having an office at 1895 Preston White Drive,
Reston, VA 20191 ("CNRI"), and the Individual or Organization
("Licensee") accessing and otherwise using Python 1.6.1 software in
source or binary form and its associated documentation.

2. Subject to the terms and conditions of this License Agreement, CNRI
hereby grants Licensee a nonexclusive, royalty-free, world-wide
license to reproduce, analyze, test, perform and/or display publicly,
prepare derivative works, distribute, and otherwise use Python 1.6.1
alone or in any derivative version, provided, however, that CNRI's
License Agreement and CNRI's notice of copyright, i.e., "Copyright (c)
1995-2001 Corporation for National Research Initiatives; All Rights
Reserved" are retained in Python 1.6.1 alone or in any derivative
version prepared by Licensee.  Alternately, in lieu of CNRI's License
Agreement, Licensee may substitute the following text (omitting the
quotes): "Python 1.6.1 is made available subject to the terms and
conditions in CNRI's License Agreement.  This Agreement together with
Python 1.6.1 may be located on the Internet using the following
unique, persistent identifier (known as a handle): 1895.22/1013.  This
Agreement may also be obtained from a proxy server on the Internet
using the following URL: http://hdl.handle.net/1895.22/1013".

3. In the event Licensee prepares a derivative work that is based on
or incorporates Python 1.6.1 or any part thereof, and wants to make
the derivative work available to others as provided herein, then
Licensee hereby agrees to include in any such work a brief summary of
the changes made to Python 1.6.1.

4. CNRI is making Python 1.6.1 available to Licensee on an "AS IS"
basis.  CNRI MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
IMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, CNRI MAKES NO AND
DISCLAIMS ANY REPRESENTATION OR WARRANTY OF MERCHANTABILITY OR FITNESS
FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF PYTHON 1.6.1 WILL NOT
INFRINGE ANY THIRD PARTY RIGHTS.

5. CNRI SHALL NOT BE LIABLE TO LICENSEE OR ANY OTHER USERS OF PYTHON
1.6.1 FOR ANY INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES OR LOSS AS
A RESULT OF MODIFYING, DISTRIBUTING, OR OTHERWISE USING PYTHON 1.6.1,
OR ANY DERIVATIVE THEREOF, EVEN IF ADVISED OF THE POSSIBILITY THEREOF.

6. This License Agreement will automatically terminate upon a material
breach of its terms and conditions.

7. This License Agreement shall be governed by the federal
intellectual property law of the United States, including without
limitation the federal copyright law, and, to the extent such
U.S. federal law does not apply, by the law of the Commonwealth of
Virginia, excluding Virginia's conflict of law provisions.
Notwithstanding the foregoing, with regard to derivative works based
on Python 1.6.1 that incorporate non-separable material that was
previously distributed under the GNU General Public License (GPL), the
law of the Commonwealth of Virginia shall govern this License
Agreement only as to issues arising under or with respect to
Paragraphs 4, 5, and 7 of this License Agreement.  Nothing in this
License Agreement shall be deemed to create any relationship of
agency, partnership, or joint venture between CNRI and Licensee.  This
License Agreement does not grant permission to use CNRI trademarks or
trade name in a trademark sense to endorse or promote products or
services of Licensee, or any third party.

8. By clicking on the "ACCEPT" button where indicated, or by copying,
installing or otherwise using Python 1.6.1, Licensee agrees to be
bound by the terms and conditions of this License Agreement.

        ACCEPT


CWI LICENSE AGREEMENT FOR PYTHON 0.9.0 THROUGH 1.2
--------------------------------------------------

Copyright (c) 1991 - 1995, Stichting Mathematisch Centrum Amsterdam,
The Netherlands.  All rights reserved.

Permission to use, copy, modify, and distribute this software and its
documentation for any purpose and without fee is hereby granted,
provided that the above copyright notice appear in all copies and that
both that copyright notice and this permission notice appear in
supporting documentation, and that the name of Stichting Mathematisch
Centrum or CWI not be used in advertising or publicity pertaining to
distribution of the software without specific, written prior
permission.

STICHTING MATHEMATISCH CENTRUM DISCLAIMS ALL WARRANTIES WITH REGARD TO
THIS SOFTWARE, INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS, IN NO EVENT SHALL STICHTING MATHEMATISCH CENTRUM BE LIABLE
FOR ANY SPECIAL, INDIRECT OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT
OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### lazy-val 1.0.5

MIT - Vladimir Krivosheev (package author; the package ships no licence file) - <https://github.com/develar/lazy-val>

The package declares `"license": "MIT"` and ships no licence file; the standard MIT text with the package author as copyright holder applies.

```text
MIT License

Copyright (c) Vladimir Krivosheev

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
```

### lodash.escaperegexp 4.1.2

MIT - Copyright jQuery Foundation and other contributors - <https://lodash.com/>

```text
Copyright jQuery Foundation and other contributors <https://jquery.org/>

Based on Underscore.js, copyright Jeremy Ashkenas,
DocumentCloud and Investigative Reporters & Editors <http://underscorejs.org/>

This software consists of voluntary contributions made by many
individuals. For exact contribution history, see the revision history
available at https://github.com/lodash/lodash

The following license applies to all parts of this software except as
documented below:

====

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

====

Copyright and related rights for sample code are waived via CC0. Sample
code is defined as all source code displayed within the prose of the
documentation.

CC0: http://creativecommons.org/publicdomain/zero/1.0/

====

Files located in the node_modules and vendor directories are externally
maintained libraries used by this software which have their own
licenses; we recommend you read them, as their terms may differ from the
terms above.
```

### lodash.isequal 4.5.0

MIT - Copyright JS Foundation and other contributors - <https://lodash.com/>

```text
Copyright JS Foundation and other contributors <https://js.foundation/>

Based on Underscore.js, copyright Jeremy Ashkenas,
DocumentCloud and Investigative Reporters & Editors <http://underscorejs.org/>

This software consists of voluntary contributions made by many
individuals. For exact contribution history, see the revision history
available at https://github.com/lodash/lodash

The following license applies to all parts of this software except as
documented below:

====

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

====

Copyright and related rights for sample code are waived via CC0. Sample
code is defined as all source code displayed within the prose of the
documentation.

CC0: http://creativecommons.org/publicdomain/zero/1.0/

====

Files located in the node_modules and vendor directories are externally
maintained libraries used by this software which have their own
licenses; we recommend you read them, as their terms may differ from the
terms above.
```

### semver 7.7.4

ISC - Copyright (c) Isaac Z. Schlueter and Contributors - <https://github.com/npm/node-semver>

```text
The ISC License

Copyright (c) Isaac Z. Schlueter and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### tiny-typed-emitter 2.1.0

MIT - Copyright (c) 2020 Zurab Benashvili (binier) - <https://github.com/binier/tiny-typed-emitter>

```text
MIT License

Copyright (c) 2020 Zurab Benashvili (binier) <zura.bena@gmail.com>

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
```

### debug 4.4.3

MIT - Copyright (c) 2014-2017 TJ Holowaychuk; Copyright (c) 2018-2021 Josh Junon - <https://github.com/debug-js/debug>

```text
(The MIT License)

Copyright (c) 2014-2017 TJ Holowaychuk <tj@vision-media.ca>
Copyright (c) 2018-2021 Josh Junon

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the 'Software'), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### ms 2.1.3

MIT - Copyright (c) 2020 Vercel, Inc. - <https://github.com/vercel/ms>

```text
The MIT License (MIT)

Copyright (c) 2020 Vercel, Inc.

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
```

### sax 1.6.1

BlueOak-1.0.0 - Isaac Z. Schlueter and contributors - <https://github.com/isaacs/sax-js>

```text
# Blue Oak Model License

Version 1.0.0

## Purpose

This license gives everyone as much permission to work with
this software as possible, while protecting contributors
from liability.

## Acceptance

In order to receive this license, you must agree to its
rules.  The rules of this license are both obligations
under that agreement and conditions to your license.
You must not do anything with this software that triggers
a rule that you cannot or will not follow.

## Copyright

Each contributor licenses you to do everything with this
software that would otherwise infringe that contributor's
copyright in it.

## Notices

You must ensure that everyone who gets a copy of
any part of this software from you, with or without
changes, also gets the text of this license or a link to
<https://blueoakcouncil.org/license/1.0.0>.

## Excuse

If anyone notifies you in writing that you have not
complied with [Notices](#notices), you can keep your
license by taking all practical steps to comply within 30
days after the notice.  If you do not do so, your license
ends immediately.

## Patent

Each contributor licenses you to do everything with this
software that would otherwise infringe any patent claims
they can license or become able to license.

## Reliability

No contributor can revoke this license.

## No Liability

***As far as the law allows, this software comes as is,
without any warranty or condition, and no contributor
will be liable to anyone for any damages related to this
software or this license, under any kind of legal claim.***
```

### electron 33.4.11

MIT - Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc. - <https://github.com/electron/electron>

```text
Copyright (c) Electron contributors
Copyright (c) 2013-2020 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### vite 6.4.3

MIT - Copyright (c) 2019-present, VoidZero Inc. and Vite contributors - <https://github.com/vitejs/vite>

```text
# Vite core license
Vite is released under the MIT license:

MIT License

Copyright (c) 2019-present, VoidZero Inc. and Vite contributors

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
```
