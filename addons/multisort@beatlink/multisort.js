/* MultiSort

Trilium 0.106.0 sorts child notes by several criteria natively, through the #sorted label:
    #sorted="priority desc, area, startDateTime, title"

This script moves every note still labelled #multiSorted onto that native sort:
    - "priority:desc;area;title:caseInsensitive" becomes #sorted="priority desc, area, title"
    - the #multiSorted label and the children's #multiSortedValue_{parentId} labels are removed

Native sorting always ignores case and has no relation keys, so a #multiSorted string with a
`~relation` criterion is left as it is and reported instead.

*/

// Converts "priority:desc;area;title:caseInsensitive" into "priority desc, area, title".
function toNativeSortString(multiSortString) {
    return multiSortString.split(";")
        .map(segment => segment.split(":").map(part => part.trim()))
        .filter(([attribute]) => attribute)
        .map(([attribute, ...flags]) => flags.includes("desc") ? `${attribute} desc` : attribute)
        .join(", ")
}

// Main Function
async function migrateToNativeSort(){
    let notesToMigrate = await api.searchForNotes("#multiSorted")

    for (let note of notesToMigrate){
        let multiSortString = note.getLabelValue("multiSorted") || ""
        if (multiSortString.split(";").some(segment => segment.trim().startsWith("~"))) {
            api.showError(`MultiSort: "${note.title}" sorts by a relation, which native #sorted cannot do; left unchanged.`)
            continue
        }
        await api.runOnBackend((noteId, sortString) => {
            let note = api.getNote(noteId)
            for (let childNote of note.getChildNotes()) {
                childNote.removeLabel(`multiSortedValue_${noteId}`)
            }
            note.removeLabel("multiSorted")
            note.setLabel("sorted", sortString)
        }, [note.noteId, toNativeSortString(multiSortString)])
    }
}

migrateToNativeSort()
