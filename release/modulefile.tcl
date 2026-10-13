#%Module 1.0
#
#  scagent module
#
module-whatis "scagent"
module-whatis "Version: @VERSION@"
module-whatis "Description: single-cell analysis agent (opencode interface, GPU compute)"

# Everything lives in one read-only release folder; nothing is installed for the user.
# The opencode below is the version this release was tested with. The lab model list is
# SCAGENT_SITE_CONFIG: the maintainer edits that one file and everyone sees the change on
# their next launch. Each user can override it in ~/.config/scagent/opencode.json.
prepend-path PATH                 @PREFIX@/bin
setenv       SCAGENT_OPENCODE_BIN @OPENCODE_BIN@
setenv       SCAGENT_SITE_CONFIG  @SITE_CONFIG@

if { [module-info mode load] } {
    puts stderr ""
    puts stderr "  scagent @VERSION@ loaded"
    puts stderr "    Start:   cd <your project folder> && scagent"
    puts stderr "    Check:   scagent doctor      Settings: scagent config"
    puts stderr "    Results: ./scagent_sessions/ in the folder you start in"
    puts stderr ""
}
