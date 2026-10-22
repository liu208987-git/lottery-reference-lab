# Third-party notices

Lottery Model Lab is distributed with or runs on the following third-party
software. This notice is informational and does not replace the license text
provided by each upstream project.

## Runtime components

| Component | Upstream | License |
| --- | --- | --- |
| Python | https://www.python.org/ | Python Software Foundation License Version 2 |
| NumPy | https://numpy.org/ | BSD 3-Clause License |
| tzdata for Python | https://github.com/python/tzdata | Apache License 2.0; bundled IANA time-zone data has its own public-domain-style notice |
| Debian | https://www.debian.org/ | Aggregate distribution; individual packages retain their respective licenses |

The container image is based on the official Python image published through
Docker Hub. Its Debian packages and Python components retain their upstream
copyright and license notices.

## Development-only component

`lunar-python` is used only to generate and verify the frozen lunar-calendar
CSV during development. It is not installed in the runtime container.

| Component | Upstream | License |
| --- | --- | --- |
| lunar-python | https://github.com/6tail/lunar-python | MIT License |

## Public lottery data

The repository contains factual historical draw records collected from public
lottery information sources. Source attribution and data-audit information are
kept in the project documentation and result manifests. No upstream website
code, branding, page design, or private user data is included in the runtime
image.

## Design references

Ramp and Linear were used as visual-design references only. No proprietary
assets, source code, fonts, logos, or design-system packages from those
products are redistributed.
