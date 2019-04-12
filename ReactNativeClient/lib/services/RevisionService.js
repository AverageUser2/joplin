const { Logger } = require('lib/logger.js');
const ItemChange = require('lib/models/ItemChange');
const Note = require('lib/models/Note');
const Folder = require('lib/models/Folder');
const Setting = require('lib/models/Setting');
const Revision = require('lib/models/Revision');
const BaseModel = require('lib/BaseModel');
const ItemChangeUtils = require('lib/services/ItemChangeUtils');
const { shim } = require('lib/shim');
const BaseService = require('lib/services/BaseService');
const { _ } = require('lib/locale.js');
const ArrayUtils = require('lib/ArrayUtils.js');

class RevisionService extends BaseService {

	static instance() {
		if (this.instance_) return this.instance_;
		this.instance_ = new RevisionService();
		return this.instance_;
	}

	noteMetadata_(note) {
		const excludedFields = ['type_', 'title', 'body', 'created_time', 'updated_time', 'encryption_applied', 'encryption_cipher_text', 'is_conflict'];
		const md = {};
		for (let k in note) {
			if (excludedFields.indexOf(k) >= 0) continue;
			md[k] = note[k];
		}
		return md;
	}

	async createNoteRevision(note, parentRevId = null) {
		const parentRev = parentRevId ? await Revision.load(parentRevId) : await Revision.latestRevision(BaseModel.TYPE_NOTE, note.id);

		const output = {
			parent_id: '',
			item_type: BaseModel.TYPE_NOTE,
			item_id: note.id,
			item_updated_time: note.updated_time,
		};

		const noteMd = this.noteMetadata_(note);
		const noteTitle = note.title ? note.title : '';
		const noteBody = note.body ? note.body : '';

		if (!parentRev) {
			output.title_diff = Revision.createTextPatch('', noteTitle);
			output.body_diff = Revision.createTextPatch('', noteBody);
			output.metadata_diff = Revision.createObjectPatch({}, noteMd);
		} else {
			const merged = await Revision.mergeDiffs(parentRev);
			output.parent_id = parentRev.id;
			output.title_diff = Revision.createTextPatch(merged.title, noteTitle);
			output.body_diff = Revision.createTextPatch(merged.body, noteBody);
			output.metadata_diff = Revision.createObjectPatch(merged.metadata, noteMd);
		}

		return Revision.save(output);
	}

	async createNoteRevisionsByIds(noteIds) {
		noteIds = ArrayUtils.unique(noteIds);

		while (noteIds.length) {
			const ids = noteIds.splice(0, 100);
			const notes = await Note.byIds(ids);
			for (const note of notes) {
				const existingRev = await Revision.latestRevision(BaseModel.TYPE_NOTE, note.id);
				if (existingRev && existingRev.item_updated_time === note.updated_time) continue;
				await this.createNoteRevision(note);
			}
		}
	}

	async createNoteRevisionsIfNoneFound(noteIds) {
		noteIds = noteIds.slice();

		while (noteIds.length) {
			let ids = noteIds.splice(0, 100);
			ids = await Revision.itemsWithNoRevisions(BaseModel.TYPE_NOTE, ids);

			for (const id of ids) {
				const note = await Note.load(id);
				if (!note) {
					this.logger().warn('RevisionService:createNoteRevisionsIfNoneFound: Could not find note ' + id);
				} else {
					await this.createNoteRevision(note);
				}
			}
		}
	}

	async collectRevisions() {
		if (this.isCollecting_) return;

		this.isCollecting_ = true;

		await ItemChange.waitForAllSaved();

		const doneNoteIds = [];

		while (true) {
			const changes = await ItemChange.modelSelectAll(`
				SELECT id, item_id, type
				FROM item_changes
				WHERE item_type = ?
				AND id > ?
				ORDER BY id ASC
				LIMIT 10
			`, [BaseModel.TYPE_NOTE, Setting.value('revisionService.lastProcessedChangeId')]);

			if (!changes.length) break;

			const noteIds = changes.map(a => a.item_id);
			const notes = await Note.modelSelectAll('SELECT * FROM notes WHERE is_conflict = 0 AND encryption_applied = 0 AND id IN ("' + noteIds.join('","') + '")');

			for (let i = 0; i < changes.length; i++) {
				const change = changes[i];
				const noteId = change.item_id;

				if (change.type !== ItemChange.TYPE_CREATE && change.type !== ItemChange.TYPE_UPDATE) continue;
				if (doneNoteIds.indexOf(noteId) >= 0) continue;

				const note = BaseModel.byId(notes, noteId);
				if (!note) continue;

				await this.createNoteRevision(note);

				doneNoteIds.push(noteId);

				Setting.setValue('revisionService.lastProcessedChangeId', change.id);
			}
		}

		await Setting.saveAll();
		await ItemChangeUtils.deleteProcessedChanges();	

		this.isCollecting_ = false;

		this.logger().info('RevisionService::collectRevisions: Created revisions for ' + doneNoteIds.length + ' notes');	
	}

	async deleteOldRevisions(ttl) {
		return Revision.deleteOldRevisions(ttl);
	}

	async revisionNote(revisions, index) {
		if (index < 0 || index >= revisions.length) throw new Error('Invalid revision index: ' + index);

		const rev = revisions[index];
		const merged = await Revision.mergeDiffs(rev, revisions);

		const output = Object.assign({
			title: merged.title,
			body: merged.body,
		}, merged.metadata);
		output.updated_time = output.user_updated_time;
		output.created_time = output.user_created_time;
		output.type_ = BaseModel.TYPE_NOTE;

		return output;
	}

	restoreFolderTitle() {
		return _('Restored Notes');
	}

	async restoreFolder() {
		let folder = await Folder.loadByTitle(this.restoreFolderTitle());
		if (!folder) {
			folder = await Folder.save({ title: this.restoreFolderTitle() });
		}
		return folder;
	}

	async importRevisionNote(note) {
		const toImport = Object.assign({}, note);
		delete toImport.id;
		delete toImport.updated_time;
		delete toImport.created_time;
		delete toImport.encryption_applied;
		delete toImport.encryption_cipher_text;

		const folder = await this.restoreFolder();

		toImport.parent_id = folder.id;

		await Note.save(toImport);
	}

	async maintenance() {
		const startTime = Date.now();
		this.logger().info('RevisionService::maintenance: Starting...');

		if (!Setting.value('revisionService.enabled')) {
			this.logger().info('RevisionService::maintenance: Service is disabled');
			// We do as if we had processed all the latest changes so that they can be cleaned up 
			// later on by ItemChangeUtils.deleteProcessedChanges().
			Setting.setValue('revisionService.lastProcessedChangeId', await ItemChange.lastChangeId());
			await this.deleteOldRevisions(Setting.value('revisionService.ttlDays') * 24 * 60 * 60 * 1000);
		} else {
			this.logger().info('RevisionService::maintenance: Service is enabled');
			await this.collectRevisions();
			await this.deleteOldRevisions(Setting.value('revisionService.ttlDays') * 24 * 60 * 60 * 1000);
		}

		this.logger().info('RevisionService::maintenance: Done in ' + (Date.now() - startTime) + 'ms');
	}

	runInBackground() {
		if (this.isRunningInBackground_) return;

		this.isRunningInBackground_ = true;

		setTimeout(() => {
			this.maintenance();
		}, 1000 * 4);
		
		shim.setInterval(() => {
			this.maintenance();
		}, 1000 * 60 * 10);
	}

}

module.exports = RevisionService;